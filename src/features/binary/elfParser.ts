import type {
  ElfHeaderSummary,
  ElfRelocation,
  ElfSection,
  ElfSegment,
  ElfSymbol,
  LoadedImage
} from './model';
import { parseElfUnwind } from './unwind';

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EM_X86_64 = 62;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const SHT_SYMTAB = 2;
const SHT_RELA = 4;
const SHT_DYNAMIC = 6;
const SHT_NOTE = 7;
const SHT_REL = 9;
const SHT_DYNSYM = 11;
const SHN_UNDEF = 0;
const STT_FUNC = 2;
const STT_GNU_IFUNC = 10;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_SONAME = 14;

function toNumber(value: bigint, field: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${field} exceeds the browser-safe integer range`);
  return n;
}

function bounded(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new Error(`${label} is outside the ELF byte range`);
  }
}

function cString(bytes: Uint8Array, offset: number, maxEnd = bytes.byteLength): string {
  if (offset < 0 || offset >= maxEnd || offset >= bytes.byteLength) return '';
  let end = offset;
  const limit = Math.min(maxEnd, bytes.byteLength);
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function machineArchitecture(machine: number): string {
  if (machine === EM_X86_64) return 'x86-64';
  return `machine-${machine}`;
}

function kindForType(type: number) {
  if (type === 1) return 'relocatable' as const;
  if (type === 2) return 'executable' as const;
  if (type === 3) return 'shared-library' as const;
  if (type === 4) return 'core' as const;
  return 'unknown' as const;
}

export function inspectElfHeader(buffer: ArrayBuffer | undefined): ElfHeaderSummary {
  if (!buffer || buffer.byteLength < 20) return { valid: false, reason: 'Not enough bytes for an ELF header.' };
  const bytes = new Uint8Array(buffer);
  if (!ELF_MAGIC.every((value, index) => bytes[index] === value)) return { valid: false, reason: 'ELF magic not found.' };
  const elfClass = bytes[4] === ELFCLASS64 ? 64 : bytes[4] === 1 ? 32 : undefined;
  const littleEndian = bytes[5] === ELFDATA2LSB;
  if (!elfClass) return { valid: false, reason: `Unsupported ELF class ${bytes[4]}.` };
  const view = new DataView(buffer);
  const type = view.getUint16(16, littleEndian);
  const machine = view.getUint16(18, littleEndian);
  let entry = 0;
  if (elfClass === 64 && buffer.byteLength >= 32) entry = Number(view.getBigUint64(24, littleEndian));
  else if (elfClass === 32 && buffer.byteLength >= 28) entry = view.getUint32(24, littleEndian);
  return { valid: true, elfClass, littleEndian, machine, architecture: machineArchitecture(machine), type, kind: kindForType(type), entry };
}

export interface ElfRuntimeLinkageSummary {
  soname: string | null;
  neededLibraries: string[];
}

/**
 * Parse only ELF metadata needed to materialize a dynamic process image.
 * This deliberately avoids symbols, relocations, unwind and function discovery:
 * dependency closure resolution must not pay the full analysis cost for libc/ld.so.
 */
export function inspectElfRuntimeLinkage(buffer: ArrayBuffer): ElfRuntimeLinkageSummary {
  const bytes = new Uint8Array(buffer);
  const header = inspectElfHeader(buffer);
  if (!header.valid) throw new Error(header.reason ?? 'Not an ELF file.');
  if (header.elfClass !== 64 || !header.littleEndian || header.machine !== EM_X86_64) {
    throw new Error(`Runtime dependency must be little-endian ELF64 x86-64; got ${header.architecture ?? 'unknown'}.`);
  }
  if (bytes.byteLength < 64) throw new Error('Truncated ELF64 header.');

  const view = new DataView(buffer);
  const phoff = toNumber(view.getBigUint64(32, true), 'program header offset');
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);

  type RuntimeSegment = { type: number; offset: number; virtualAddress: number; fileSize: number };
  const segments: RuntimeSegment[] = [];
  if (phoff && phnum) {
    if (phentsize < 56) throw new Error(`Unexpected ELF64 program-header size ${phentsize}.`);
    bounded(bytes, phoff, phentsize * phnum, 'program-header table');
    for (let index = 0; index < phnum; index += 1) {
      const offset = phoff + index * phentsize;
      const type = view.getUint32(offset, true);
      const fileOffset = toNumber(view.getBigUint64(offset + 8, true), `segment ${index} file offset`);
      const virtualAddress = toNumber(view.getBigUint64(offset + 16, true), `segment ${index} virtual address`);
      const fileSize = toNumber(view.getBigUint64(offset + 32, true), `segment ${index} file size`);
      if (fileSize) bounded(bytes, fileOffset, fileSize, `segment ${index}`);
      segments.push({ type, offset: fileOffset, virtualAddress, fileSize });
    }
  }

  const dynamicSegment = segments.find((segment) => segment.type === PT_DYNAMIC);
  if (dynamicSegment) {
    const entryCount = Math.floor(dynamicSegment.fileSize / 16);
    const neededOffsets: number[] = [];
    let sonameOffset: number | null = null;
    let stringTableAddress: number | null = null;
    let stringTableSize = 0;

    for (let index = 0; index < entryCount; index += 1) {
      const offset = dynamicSegment.offset + index * 16;
      bounded(bytes, offset, 16, `PT_DYNAMIC tag ${index}`);
      const tag = Number(view.getBigInt64(offset, true));
      const value = toNumber(view.getBigUint64(offset + 8, true), `dynamic tag ${tag}`);
      if (tag === 0) break;
      if (tag === DT_NEEDED) neededOffsets.push(value);
      else if (tag === DT_STRTAB) stringTableAddress = value;
      else if (tag === DT_STRSZ) stringTableSize = value;
      else if (tag === DT_SONAME) sonameOffset = value;
    }

    if (stringTableAddress !== null) {
      const mapping = segments.find((segment) =>
        segment.type === PT_LOAD &&
        stringTableAddress >= segment.virtualAddress &&
        stringTableAddress < segment.virtualAddress + segment.fileSize
      );
      if (!mapping) throw new Error(`ELF DT_STRTAB 0x${stringTableAddress.toString(16)} is not file-backed by PT_LOAD.`);
      const stringTableOffset = mapping.offset + (stringTableAddress - mapping.virtualAddress);
      const mappingEnd = mapping.offset + mapping.fileSize;
      const stringTableEnd = stringTableSize > 0 ? Math.min(mappingEnd, stringTableOffset + stringTableSize) : mappingEnd;
      bounded(bytes, stringTableOffset, Math.max(0, stringTableEnd - stringTableOffset), 'dynamic string table');
      const neededLibraries = neededOffsets
        .map((offset) => cString(bytes, stringTableOffset + offset, stringTableEnd))
        .filter(Boolean);
      const soname = sonameOffset === null ? null : cString(bytes, stringTableOffset + sonameOffset, stringTableEnd) || null;
      return { soname, neededLibraries: [...new Set(neededLibraries)] };
    }
  }

  // Fallback for unusual ELF files with section metadata but no file-backed PT_DYNAMIC.
  const shoff = toNumber(view.getBigUint64(40, true), 'section header offset');
  const shentsize = view.getUint16(58, true);
  const shnum = view.getUint16(60, true);
  if (!shoff || !shnum) return { soname: null, neededLibraries: [] };
  if (shentsize < 64) throw new Error(`Unexpected ELF64 section-header size ${shentsize}.`);
  bounded(bytes, shoff, shentsize * shnum, 'section-header table');

  type LinkageSection = { type: number; offset: number; size: number; link: number; entrySize: number };
  const sections: LinkageSection[] = [];
  for (let index = 0; index < shnum; index += 1) {
    const offset = shoff + index * shentsize;
    const type = view.getUint32(offset + 4, true);
    const fileOffset = toNumber(view.getBigUint64(offset + 24, true), `section ${index} offset`);
    const size = toNumber(view.getBigUint64(offset + 32, true), `section ${index} size`);
    const link = view.getUint32(offset + 40, true);
    const entrySize = toNumber(view.getBigUint64(offset + 56, true), `section ${index} entry size`);
    if (type !== 8 && size) bounded(bytes, fileOffset, size, `section ${index}`);
    sections.push({ type, offset: fileOffset, size, link, entrySize });
  }

  const neededLibraries: string[] = [];
  let soname: string | null = null;
  for (const section of sections) {
    if (section.type !== SHT_DYNAMIC) continue;
    const stringSection = sections[section.link];
    if (!stringSection) continue;
    const entrySize = section.entrySize || 16;
    const count = Math.floor(section.size / entrySize);
    for (let index = 0; index < count; index += 1) {
      const offset = section.offset + index * entrySize;
      bounded(bytes, offset, 16, `dynamic tag ${index}`);
      const tag = Number(view.getBigInt64(offset, true));
      const value = toNumber(view.getBigUint64(offset + 8, true), `dynamic tag ${tag}`);
      if (tag === 0) break;
      if (tag === DT_NEEDED) neededLibraries.push(cString(bytes, stringSection.offset + value, stringSection.offset + stringSection.size));
      if (tag === DT_SONAME) soname = cString(bytes, stringSection.offset + value, stringSection.offset + stringSection.size) || null;
    }
  }
  return { soname, neededLibraries: [...new Set(neededLibraries.filter(Boolean))] };
}

function parseBuildId(bytes: Uint8Array, view: DataView, section: ElfSection): string | null {
  if (section.type !== SHT_NOTE || section.size < 16) return null;
  let cursor = section.offset;
  const end = section.offset + section.size;
  while (cursor + 12 <= end) {
    const namesz = view.getUint32(cursor, true);
    const descsz = view.getUint32(cursor + 4, true);
    const type = view.getUint32(cursor + 8, true);
    cursor += 12;
    if (cursor + align4(namesz) + align4(descsz) > end) break;
    const name = cString(bytes, cursor, cursor + namesz);
    cursor += align4(namesz);
    const desc = bytes.subarray(cursor, cursor + descsz);
    cursor += align4(descsz);
    if (name === 'GNU' && type === 3 && desc.length) return [...desc].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

export function parseElfImage(fileId: string, sourcePath: string, buffer: ArrayBuffer): LoadedImage {
  const bytes = new Uint8Array(buffer);
  const header = inspectElfHeader(buffer);
  if (!header.valid) throw new Error(header.reason ?? 'Not an ELF file');
  if (header.elfClass !== 64) throw new Error('The migrated binary pipeline currently accepts ELF64 only.');
  if (!header.littleEndian) throw new Error('The migrated binary pipeline currently accepts little-endian ELF only.');
  if (header.machine !== EM_X86_64) throw new Error(`Capstone x86 provider cannot decode ${header.architecture}.`);
  if (bytes.byteLength < 64) throw new Error('Truncated ELF64 header.');

  const view = new DataView(buffer);
  const entry = toNumber(view.getBigUint64(24, true), 'ELF entrypoint');
  const phoff = toNumber(view.getBigUint64(32, true), 'program header offset');
  const shoff = toNumber(view.getBigUint64(40, true), 'section header offset');
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  const shentsize = view.getUint16(58, true);
  const shnum = view.getUint16(60, true);
  const shstrndx = view.getUint16(62, true);

  const segments: ElfSegment[] = [];
  let interpreter: string | null = null;
  if (phoff && phnum) {
    if (phentsize < 56) throw new Error(`Unexpected ELF64 program-header size ${phentsize}.`);
    bounded(bytes, phoff, phentsize * phnum, 'program-header table');
    for (let index = 0; index < phnum; index += 1) {
      const offset = phoff + index * phentsize;
      const type = view.getUint32(offset, true);
      const flags = view.getUint32(offset + 4, true);
      const fileOffset = toNumber(view.getBigUint64(offset + 8, true), `segment ${index} file offset`);
      const virtualAddress = toNumber(view.getBigUint64(offset + 16, true), `segment ${index} virtual address`);
      const fileSize = toNumber(view.getBigUint64(offset + 32, true), `segment ${index} file size`);
      const memorySize = toNumber(view.getBigUint64(offset + 40, true), `segment ${index} memory size`);
      const alignment = toNumber(view.getBigUint64(offset + 48, true), `segment ${index} alignment`);
      if (fileSize) bounded(bytes, fileOffset, fileSize, `segment ${index}`);
      if (type === PT_INTERP && fileSize) interpreter = cString(bytes, fileOffset, fileOffset + fileSize) || null;
      if (type === PT_LOAD) {
        segments.push({
          index,
          type,
          flags,
          offset: fileOffset,
          virtualAddress,
          fileSize,
          memorySize,
          alignment,
          readable: (flags & 4) !== 0,
          writable: (flags & 2) !== 0,
          executable: (flags & 1) !== 0
        });
      }
    }
  }

  type RawSection = ElfSection & { nameOffset: number };
  const rawSections: RawSection[] = [];
  if (shoff && shnum) {
    if (shentsize < 64) throw new Error(`Unexpected ELF64 section-header size ${shentsize}.`);
    bounded(bytes, shoff, shentsize * shnum, 'section-header table');
    for (let index = 0; index < shnum; index += 1) {
      const offset = shoff + index * shentsize;
      const nameOffset = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const flags = toNumber(view.getBigUint64(offset + 8, true), `section ${index} flags`);
      const address = toNumber(view.getBigUint64(offset + 16, true), `section ${index} address`);
      const fileOffset = toNumber(view.getBigUint64(offset + 24, true), `section ${index} offset`);
      const size = toNumber(view.getBigUint64(offset + 32, true), `section ${index} size`);
      const link = view.getUint32(offset + 40, true);
      const info = view.getUint32(offset + 44, true);
      const alignment = toNumber(view.getBigUint64(offset + 48, true), `section ${index} alignment`);
      const entrySize = toNumber(view.getBigUint64(offset + 56, true), `section ${index} entry size`);
      if (type !== 8 && size) bounded(bytes, fileOffset, size, `section ${index}`);
      rawSections.push({
        index,
        name: '',
        nameOffset,
        type,
        flags,
        address,
        offset: fileOffset,
        size,
        link,
        info,
        alignment,
        entrySize,
        executable: (flags & 0x4) !== 0,
        writable: (flags & 0x1) !== 0,
        allocated: (flags & 0x2) !== 0
      });
    }
  }

  const shstr = rawSections[shstrndx];
  const sections: ElfSection[] = rawSections.map(({ nameOffset, ...section }) => ({
    ...section,
    name: shstr && shstr.type !== 8 ? cString(bytes, shstr.offset + nameOffset, shstr.offset + shstr.size) : `section_${section.index}`
  }));

  const symbols: ElfSymbol[] = [];
  const symbolsByTable = new Map<number, ElfSymbol[]>();
  for (const section of sections) {
    if (section.type !== SHT_SYMTAB && section.type !== SHT_DYNSYM) continue;
    const stringSection = sections[section.link];
    const entrySize = section.entrySize || 24;
    if (!stringSection || entrySize < 24) continue;
    const count = Math.floor(section.size / entrySize);
    const tableSymbols: ElfSymbol[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = section.offset + index * entrySize;
      bounded(bytes, offset, 24, `symbol ${section.name}[${index}]`);
      const nameOffset = view.getUint32(offset, true);
      const info = view.getUint8(offset + 4);
      const other = view.getUint8(offset + 5);
      const sectionIndex = view.getUint16(offset + 6, true);
      const value = toNumber(view.getBigUint64(offset + 8, true), `symbol ${index} value`);
      const size = toNumber(view.getBigUint64(offset + 16, true), `symbol ${index} size`);
      const type = info & 0xf;
      const symbol: ElfSymbol = {
        index,
        tableSectionIndex: section.index,
        name: cString(bytes, stringSection.offset + nameOffset, stringSection.offset + stringSection.size),
        value,
        size,
        binding: info >> 4,
        type,
        visibility: other & 0x3,
        sectionIndex,
        defined: sectionIndex !== SHN_UNDEF,
        functionLike: (type === STT_FUNC || type === STT_GNU_IFUNC) && sectionIndex !== SHN_UNDEF && value !== 0
      };
      tableSymbols.push(symbol);
      symbols.push(symbol);
    }
    symbolsByTable.set(section.index, tableSymbols);
  }

  const relocations: ElfRelocation[] = [];
  for (const section of sections) {
    if (section.type !== SHT_RELA && section.type !== SHT_REL) continue;
    const entrySize = section.entrySize || (section.type === SHT_RELA ? 24 : 16);
    const symbolTable = symbolsByTable.get(section.link) ?? [];
    const count = Math.floor(section.size / entrySize);
    for (let index = 0; index < count; index += 1) {
      const offset = section.offset + index * entrySize;
      bounded(bytes, offset, section.type === SHT_RELA ? 24 : 16, `relocation ${section.name}[${index}]`);
      const relocOffset = toNumber(view.getBigUint64(offset, true), `relocation ${index} offset`);
      const info = view.getBigUint64(offset + 8, true);
      const symbolIndex = Number(info >> 32n);
      const type = Number(info & 0xffffffffn);
      const addend = section.type === SHT_RELA ? Number(view.getBigInt64(offset + 16, true)) : null;
      relocations.push({
        sectionIndex: section.index,
        sectionName: section.name,
        offset: relocOffset,
        type,
        symbolIndex,
        symbolName: symbolTable[symbolIndex]?.name ?? '',
        addend
      });
    }
  }

  const neededLibraries: string[] = [];
  let soname: string | null = null;
  for (const section of sections) {
    if (section.type !== SHT_DYNAMIC) continue;
    const stringSection = sections[section.link];
    if (!stringSection) continue;
    const entrySize = section.entrySize || 16;
    const count = Math.floor(section.size / entrySize);
    for (let index = 0; index < count; index += 1) {
      const offset = section.offset + index * entrySize;
      bounded(bytes, offset, 16, `dynamic tag ${index}`);
      const tag = Number(view.getBigInt64(offset, true));
      const value = toNumber(view.getBigUint64(offset + 8, true), `dynamic tag ${tag}`);
      if (tag === 0) break;
      if (tag === DT_NEEDED) neededLibraries.push(cString(bytes, stringSection.offset + value, stringSection.offset + stringSection.size));
      if (tag === DT_SONAME) soname = cString(bytes, stringSection.offset + value, stringSection.offset + stringSection.size) || null;
    }
  }

  let buildId: string | null = null;
  for (const section of sections) {
    if (section.name === '.note.gnu.build-id' || section.type === SHT_NOTE) {
      buildId = parseBuildId(bytes, view, section) ?? buildId;
      if (buildId) break;
    }
  }

  const functions = symbols
    .filter((symbol) => symbol.functionLike)
    .sort((a, b) => a.value - b.value || b.size - a.size || a.name.localeCompare(b.name));
  const unwind = parseElfUnwind(buffer, sections);

  return {
    schema: 'asm-graph.loaded-image/v1',
    sourceFileId: fileId,
    sourcePath,
    architecture: 'x86-64',
    byteOrder: 'little',
    kind: header.type === 3 && interpreter ? 'pie-executable' : header.kind ?? 'unknown',
    entry,
    buildId,
    soname,
    neededLibraries: [...new Set(neededLibraries.filter(Boolean))],
    interpreter,
    segments,
    sections,
    symbols,
    relocations,
    functions,
    unwind
  };
}

export function executableBytesForRange(image: LoadedImage, buffer: ArrayBuffer, address: number, maxBytes: number): Uint8Array {
  const bytes = new Uint8Array(buffer);
  const mapping = image.segments.find((segment) => segment.executable && address >= segment.virtualAddress && address < segment.virtualAddress + segment.fileSize);
  if (!mapping) throw new Error(`Address 0x${address.toString(16)} is not backed by executable PT_LOAD bytes.`);
  const relative = address - mapping.virtualAddress;
  const fileOffset = mapping.offset + relative;
  const available = mapping.fileSize - relative;
  const length = Math.max(0, Math.min(maxBytes, available));
  bounded(bytes, fileOffset, length, 'executable byte range');
  return bytes.slice(fileOffset, fileOffset + length);
}

export function functionForAddress(image: LoadedImage, address: number): ElfSymbol | null {
  const exact = image.functions.find((symbol) => symbol.value === address);
  if (exact) return exact;
  return image.functions.find((symbol) => symbol.size > 0 && address >= symbol.value && address < symbol.value + symbol.size) ?? null;
}
