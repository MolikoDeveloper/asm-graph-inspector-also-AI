const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EM_X86_64 = 62;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_VERDEF = 0x6ffffffc;
const DT_VERDEFNUM = 0x6ffffffd;
const DT_VERNEED = 0x6ffffffe;
const DT_VERNEEDNUM = 0x6fffffff;

interface FileBackedSegment {
  offset: number;
  virtualAddress: number;
  fileSize: number;
}

export interface ElfSymbolVersionRequirement {
  library: string;
  versions: string[];
}

export interface ElfSymbolVersionSummary {
  requirements: ElfSymbolVersionRequirement[];
  definitions: string[];
}

function toNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${field} exceeds the browser-safe integer range.`);
  return number;
}

function bounded(bytes: Uint8Array, offset: number, size: number, field: string): void {
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || offset + size > bytes.byteLength) {
    throw new Error(`${field} is outside the ELF byte range.`);
  }
}

function cString(bytes: Uint8Array, offset: number, end: number): string {
  if (offset < 0 || offset >= end || offset >= bytes.byteLength) return '';
  let cursor = offset;
  const limit = Math.min(end, bytes.byteLength);
  while (cursor < limit && bytes[cursor] !== 0) cursor += 1;
  return new TextDecoder().decode(bytes.subarray(offset, cursor));
}

function vaToOffset(segments: readonly FileBackedSegment[], address: number, size: number, field: string): number {
  const segment = segments.find((candidate) =>
    address >= candidate.virtualAddress &&
    address + size <= candidate.virtualAddress + candidate.fileSize
  );
  if (!segment) throw new Error(`${field} at 0x${address.toString(16)} is not file-backed by PT_LOAD.`);
  return segment.offset + (address - segment.virtualAddress);
}

/**
 * Parse GNU ELF symbol-version metadata from the dynamic image itself.
 * PT_DYNAMIC addresses are authoritative; section headers are deliberately not
 * required so stripped runtime libraries remain checkable before Blink launch.
 */
export function inspectElfSymbolVersions(buffer: ArrayBuffer): ElfSymbolVersionSummary {
  if (buffer.byteLength < 64) throw new Error('Symbol-version inspection requires an ELF64 header.');
  const bytes = new Uint8Array(buffer);
  if (!ELF_MAGIC.every((value, index) => bytes[index] === value)) throw new Error('ELF magic not found.');
  if (bytes[4] !== ELFCLASS64 || bytes[5] !== ELFDATA2LSB) throw new Error('Symbol-version inspection currently requires little-endian ELF64.');
  const view = new DataView(buffer);
  if (view.getUint16(18, true) !== EM_X86_64) throw new Error('Symbol-version inspection currently requires x86-64 ELF.');

  const phoff = toNumber(view.getBigUint64(32, true), 'program-header offset');
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  if (!phoff || !phnum) return { requirements: [], definitions: [] };
  if (phentsize < 56) throw new Error(`Unexpected ELF64 program-header size ${phentsize}.`);
  bounded(bytes, phoff, phentsize * phnum, 'program-header table');

  const loadSegments: FileBackedSegment[] = [];
  let dynamic: { offset: number; fileSize: number } | null = null;
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize;
    const type = view.getUint32(offset, true);
    const fileOffset = toNumber(view.getBigUint64(offset + 8, true), `segment ${index} file offset`);
    const virtualAddress = toNumber(view.getBigUint64(offset + 16, true), `segment ${index} virtual address`);
    const fileSize = toNumber(view.getBigUint64(offset + 32, true), `segment ${index} file size`);
    if (fileSize) bounded(bytes, fileOffset, fileSize, `segment ${index}`);
    if (type === PT_LOAD) loadSegments.push({ offset: fileOffset, virtualAddress, fileSize });
    if (type === PT_DYNAMIC) dynamic = { offset: fileOffset, fileSize };
  }
  if (!dynamic) return { requirements: [], definitions: [] };

  let stringTableAddress: number | null = null;
  let stringTableSize = 0;
  let verneedAddress: number | null = null;
  let verneedCount = 0;
  let verdefAddress: number | null = null;
  let verdefCount = 0;
  const dynamicCount = Math.floor(dynamic.fileSize / 16);
  for (let index = 0; index < dynamicCount; index += 1) {
    const offset = dynamic.offset + index * 16;
    bounded(bytes, offset, 16, `PT_DYNAMIC tag ${index}`);
    const tag = Number(view.getBigInt64(offset, true));
    const value = toNumber(view.getBigUint64(offset + 8, true), `dynamic tag ${tag}`);
    if (tag === 0) break;
    if (tag === DT_STRTAB) stringTableAddress = value;
    else if (tag === DT_STRSZ) stringTableSize = value;
    else if (tag === DT_VERNEED) verneedAddress = value;
    else if (tag === DT_VERNEEDNUM) verneedCount = value;
    else if (tag === DT_VERDEF) verdefAddress = value;
    else if (tag === DT_VERDEFNUM) verdefCount = value;
  }

  if (stringTableAddress === null) return { requirements: [], definitions: [] };
  const stringTableOffset = vaToOffset(loadSegments, stringTableAddress, Math.max(1, stringTableSize), 'DT_STRTAB');
  const stringTableEnd = stringTableSize > 0 ? stringTableOffset + stringTableSize : bytes.byteLength;
  bounded(bytes, stringTableOffset, Math.max(0, stringTableEnd - stringTableOffset), 'dynamic string table');
  const stringAt = (offset: number) => cString(bytes, stringTableOffset + offset, stringTableEnd);

  const requirementMap = new Map<string, Set<string>>();
  if (verneedAddress !== null && verneedCount > 0) {
    let currentAddress = verneedAddress;
    for (let index = 0; index < verneedCount; index += 1) {
      const offset = vaToOffset(loadSegments, currentAddress, 16, `DT_VERNEED[${index}]`);
      const auxiliaryCount = view.getUint16(offset + 2, true);
      const fileNameOffset = view.getUint32(offset + 4, true);
      const auxiliaryOffset = view.getUint32(offset + 8, true);
      const nextOffset = view.getUint32(offset + 12, true);
      const library = stringAt(fileNameOffset);
      const versions = requirementMap.get(library) ?? new Set<string>();
      let auxiliaryAddress = currentAddress + auxiliaryOffset;
      for (let auxIndex = 0; auxIndex < auxiliaryCount; auxIndex += 1) {
        const aux = vaToOffset(loadSegments, auxiliaryAddress, 16, `DT_VERNEED[${index}].aux[${auxIndex}]`);
        const nameOffset = view.getUint32(aux + 8, true);
        const auxNext = view.getUint32(aux + 12, true);
        const name = stringAt(nameOffset);
        if (name) versions.add(name);
        if (!auxNext) break;
        auxiliaryAddress += auxNext;
      }
      if (library) requirementMap.set(library, versions);
      if (!nextOffset) break;
      currentAddress += nextOffset;
    }
  }

  const definitions = new Set<string>();
  if (verdefAddress !== null && verdefCount > 0) {
    let currentAddress = verdefAddress;
    for (let index = 0; index < verdefCount; index += 1) {
      const offset = vaToOffset(loadSegments, currentAddress, 20, `DT_VERDEF[${index}]`);
      const auxiliaryOffset = view.getUint32(offset + 12, true);
      const nextOffset = view.getUint32(offset + 16, true);
      if (auxiliaryOffset) {
        const aux = vaToOffset(loadSegments, currentAddress + auxiliaryOffset, 8, `DT_VERDEF[${index}].aux`);
        const name = stringAt(view.getUint32(aux, true));
        if (name) definitions.add(name);
      }
      if (!nextOffset) break;
      currentAddress += nextOffset;
    }
  }

  return {
    requirements: [...requirementMap.entries()].map(([library, versions]) => ({ library, versions: [...versions] })),
    definitions: [...definitions]
  };
}
