import type { ElfSection, ElfUnwindFde, ElfUnwindModel } from './model';

const DW_EH_PE = Object.freeze({
  absptr: 0x00,
  uleb128: 0x01,
  udata2: 0x02,
  udata4: 0x03,
  udata8: 0x04,
  sleb128: 0x09,
  sdata2: 0x0a,
  sdata4: 0x0b,
  sdata8: 0x0c,
  pcrel: 0x10,
  textrel: 0x20,
  datarel: 0x30,
  funcrel: 0x40,
  aligned: 0x50,
  indirect: 0x80,
  omit: 0xff
});

interface CieRecord {
  address: number;
  sectionOffset: number;
  augmentation: string;
  addressSize: number;
  fdeEncoding: number;
  lsdaEncoding: number;
  parseComplete: boolean;
}

class Reader {
  constructor(
    private readonly view: DataView,
    public pos: number,
    public readonly end: number,
    private readonly littleEndian: boolean
  ) {}

  ensure(size: number): void {
    if (this.pos + size > this.end) throw new Error('truncated DWARF frame data');
  }

  u8(): number { this.ensure(1); return this.view.getUint8(this.pos++); }
  i8(): number { this.ensure(1); return this.view.getInt8(this.pos++); }
  u16(): number { this.ensure(2); const value = this.view.getUint16(this.pos, this.littleEndian); this.pos += 2; return value; }
  i16(): number { this.ensure(2); const value = this.view.getInt16(this.pos, this.littleEndian); this.pos += 2; return value; }
  u32(): number { this.ensure(4); const value = this.view.getUint32(this.pos, this.littleEndian); this.pos += 4; return value; }
  i32(): number { this.ensure(4); const value = this.view.getInt32(this.pos, this.littleEndian); this.pos += 4; return value; }

  u64BigInt(): bigint {
    this.ensure(8);
    const value = this.view.getBigUint64(this.pos, this.littleEndian);
    this.pos += 8;
    return value;
  }

  u64(): number {
    const value = this.u64BigInt();
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('64-bit DWARF value exceeds browser-safe integer range');
    return number;
  }

  i64(): number {
    this.ensure(8);
    const value = this.view.getBigInt64(this.pos, this.littleEndian);
    this.pos += 8;
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('signed 64-bit DWARF value exceeds browser-safe integer range');
    return number;
  }

  uleb(): number {
    let result = 0;
    let shift = 0;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    throw new Error('ULEB128 exceeds supported width');
  }

  sleb(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    for (let index = 0; index < 10; index += 1) {
      byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    if (shift < 53 && (byte & 0x40) !== 0) result -= 2 ** shift;
    return result;
  }

  cstr(): string {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset, this.view.byteLength);
    const start = this.pos;
    while (this.pos < this.end && bytes[this.pos] !== 0) this.pos += 1;
    const value = new TextDecoder().decode(bytes.subarray(start, this.pos));
    if (this.pos < this.end) this.pos += 1;
    return value;
  }
}

function sectionView(buffer: ArrayBuffer, section: ElfSection): DataView {
  if (section.offset < 0 || section.size < 0 || section.offset + section.size > buffer.byteLength) {
    throw new Error(`${section.name} is outside the ELF file range`);
  }
  return new DataView(buffer, section.offset, section.size);
}

function readEncoded(
  reader: Reader,
  encoding: number,
  context: { sectionAddress: number; pointerSize: number; textBase?: number; dataBase?: number; functionBase?: number }
): number | null {
  if (encoding === DW_EH_PE.omit) return null;
  const application = encoding & 0x70;
  const format = encoding & 0x0f;
  const pointerSize = context.pointerSize;

  if (application === DW_EH_PE.aligned) {
    const absolute = context.sectionAddress + reader.pos;
    const aligned = Math.ceil(absolute / pointerSize) * pointerSize;
    reader.pos += aligned - absolute;
  }

  const fieldAddress = context.sectionAddress + reader.pos;
  let raw: number;
  switch (format) {
    case DW_EH_PE.absptr: raw = pointerSize === 8 ? reader.u64() : reader.u32(); break;
    case DW_EH_PE.uleb128: raw = reader.uleb(); break;
    case DW_EH_PE.udata2: raw = reader.u16(); break;
    case DW_EH_PE.udata4: raw = reader.u32(); break;
    case DW_EH_PE.udata8: raw = reader.u64(); break;
    case DW_EH_PE.sleb128: raw = reader.sleb(); break;
    case DW_EH_PE.sdata2: raw = reader.i16(); break;
    case DW_EH_PE.sdata4: raw = reader.i32(); break;
    case DW_EH_PE.sdata8: raw = reader.i64(); break;
    default: throw new Error(`unsupported DW_EH_PE format 0x${format.toString(16)}`);
  }

  if (application === DW_EH_PE.pcrel) return fieldAddress + raw;
  if (application === DW_EH_PE.textrel && context.textBase !== undefined) return context.textBase + raw;
  if (application === DW_EH_PE.datarel && context.dataBase !== undefined) return context.dataBase + raw;
  if (application === DW_EH_PE.funcrel && context.functionBase !== undefined) return context.functionBase + raw;
  return raw;
}

function parseEhFrame(buffer: ArrayBuffer, section: ElfSection, sections: ElfSection[]): { fdes: ElfUnwindFde[]; errors: string[] } {
  const view = sectionView(buffer, section);
  const reader = new Reader(view, 0, view.byteLength, true);
  const fdes: ElfUnwindFde[] = [];
  const errors: string[] = [];
  const cies = new Map<number, CieRecord>();
  const textBase = sections.find((candidate) => candidate.name === '.text')?.address;
  const dataBase = sections.find((candidate) => candidate.name === '.data')?.address;

  while (reader.pos + 4 <= reader.end) {
    const entryOffset = reader.pos;
    const entryAddress = section.address + entryOffset;
    let length = reader.u32();
    let offsetSize = 4;
    if (length === 0) break;
    if (length === 0xffffffff) {
      try { length = reader.u64(); offsetSize = 8; }
      catch (error) { errors.push(`${section.name}@0x${entryAddress.toString(16)}: ${String(error)}`); break; }
    }
    const bodyStart = reader.pos;
    const entryEnd = bodyStart + length;
    if (length < offsetSize || entryEnd > reader.end) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: invalid/truncated entry length`);
      break;
    }

    try {
      const idFieldOffset = reader.pos;
      const idFieldAddress = section.address + idFieldOffset;
      const ciePointerRaw = offsetSize === 8 ? reader.u64BigInt() : BigInt(reader.u32());
      if (ciePointerRaw === 0n) {
        const version = reader.u8();
        const augmentation = reader.cstr();
        let addressSize = 8;
        if (version >= 4) { addressSize = reader.u8(); reader.u8(); }
        reader.uleb(); // code alignment
        reader.sleb(); // data alignment
        if (version === 1) reader.u8(); else reader.uleb(); // return register
        const cie: CieRecord = {
          address: entryAddress,
          sectionOffset: entryOffset,
          augmentation,
          addressSize,
          fdeEncoding: DW_EH_PE.absptr,
          lsdaEncoding: DW_EH_PE.omit,
          parseComplete: true
        };
        if (augmentation.startsWith('z')) {
          const augmentationLength = reader.uleb();
          const augmentationEnd = Math.min(entryEnd, reader.pos + augmentationLength);
          for (const character of augmentation.slice(1)) {
            if (reader.pos >= augmentationEnd) break;
            if (character === 'L') cie.lsdaEncoding = reader.u8();
            else if (character === 'R') cie.fdeEncoding = reader.u8();
            else if (character === 'P') {
              const personalityEncoding = reader.u8();
              readEncoded(reader, personalityEncoding, { sectionAddress: section.address, pointerSize: cie.addressSize, textBase, dataBase });
            } else if (character !== 'S') {
              cie.parseComplete = false;
              reader.pos = augmentationEnd;
              break;
            }
          }
          reader.pos = augmentationEnd;
        }
        cies.set(entryAddress, cie);
      } else {
        const ciePointer = Number(ciePointerRaw);
        if (!Number.isSafeInteger(ciePointer)) throw new Error('64-bit CIE pointer exceeds browser-safe integer range');
        const cieAddress = idFieldAddress - ciePointer;
        const cie = cies.get(cieAddress);
        if (!cie) throw new Error(`FDE references unknown CIE 0x${cieAddress.toString(16)}`);
        const startAddress = readEncoded(reader, cie.fdeEncoding, { sectionAddress: section.address, pointerSize: cie.addressSize, textBase, dataBase });
        const rangeEncoding = cie.fdeEncoding & 0x0f;
        const addressRange = readEncoded(reader, rangeEncoding, { sectionAddress: section.address, pointerSize: cie.addressSize, textBase, dataBase, functionBase: startAddress ?? undefined });
        if (startAddress !== null && addressRange !== null && addressRange > 0) {
          fdes.push({
            id: `${section.index}:fde:${entryAddress.toString(16)}`,
            source: 'eh_frame',
            entryAddress,
            cieAddress,
            startAddress,
            endAddress: startAddress + addressRange,
            addressRange,
            sectionIndex: section.index,
            sectionName: section.name,
            parseComplete: cie.parseComplete
          });
        }
      }
    } catch (error) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    reader.pos = entryEnd;
  }

  return { fdes, errors };
}

function parseDebugFrame(buffer: ArrayBuffer, section: ElfSection): { fdes: ElfUnwindFde[]; errors: string[] } {
  const view = sectionView(buffer, section);
  const reader = new Reader(view, 0, view.byteLength, true);
  const fdes: ElfUnwindFde[] = [];
  const errors: string[] = [];
  const cies = new Map<number, CieRecord>();

  while (reader.pos + 4 <= reader.end) {
    const entryOffset = reader.pos;
    const entryAddress = section.address + entryOffset;
    let length = reader.u32();
    let offsetSize = 4;
    if (length === 0) continue;
    if (length === 0xffffffff) { length = reader.u64(); offsetSize = 8; }
    const bodyStart = reader.pos;
    const entryEnd = bodyStart + length;
    if (length < offsetSize || entryEnd > reader.end) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: invalid/truncated entry length`);
      break;
    }

    try {
      const cieIdRaw = offsetSize === 8 ? reader.u64BigInt() : BigInt(reader.u32());
      const isCie = offsetSize === 8 ? cieIdRaw === 0xffffffffffffffffn : cieIdRaw === 0xffffffffn;
      if (isCie) {
        const version = reader.u8();
        const augmentation = reader.cstr();
        let addressSize = 8;
        if (version >= 4) { addressSize = reader.u8(); reader.u8(); }
        reader.uleb();
        reader.sleb();
        if (version === 1) reader.u8(); else reader.uleb();
        cies.set(entryOffset, {
          address: entryAddress,
          sectionOffset: entryOffset,
          augmentation,
          addressSize,
          fdeEncoding: DW_EH_PE.absptr,
          lsdaEncoding: DW_EH_PE.omit,
          parseComplete: true
        });
      } else {
        const cieId = Number(cieIdRaw);
        if (!Number.isSafeInteger(cieId)) throw new Error('64-bit CIE offset exceeds browser-safe integer range');
        const cie = cies.get(cieId);
        if (!cie) throw new Error(`FDE references unknown CIE offset 0x${cieId.toString(16)}`);
        const startAddress = cie.addressSize === 8 ? reader.u64() : reader.u32();
        const addressRange = cie.addressSize === 8 ? reader.u64() : reader.u32();
        if (addressRange > 0) {
          fdes.push({
            id: `${section.index}:debug-fde:${entryAddress.toString(16)}`,
            source: 'debug_frame',
            entryAddress,
            cieAddress: cie.address,
            startAddress,
            endAddress: startAddress + addressRange,
            addressRange,
            sectionIndex: section.index,
            sectionName: section.name,
            parseComplete: true
          });
        }
      }
    } catch (error) {
      errors.push(`${section.name}@0x${entryAddress.toString(16)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    reader.pos = entryEnd;
  }

  return { fdes, errors };
}

function preferNonOverlappingFdes(fdes: ElfUnwindFde[]): ElfUnwindFde[] {
  const sourceRank = (fde: ElfUnwindFde) => fde.source === 'debug_frame' ? 0 : 1;
  const byStart = new Map<number, ElfUnwindFde>();
  for (const fde of fdes) {
    const previous = byStart.get(fde.startAddress);
    if (!previous || sourceRank(fde) < sourceRank(previous) || (sourceRank(fde) === sourceRank(previous) && fde.endAddress > previous.endAddress)) {
      byStart.set(fde.startAddress, fde);
    }
  }
  const accepted: ElfUnwindFde[] = [];
  for (const fde of [...byStart.values()].sort((a, b) => a.startAddress - b.startAddress || a.endAddress - b.endAddress)) {
    if (accepted.some((other) => fde.startAddress < other.endAddress && fde.endAddress > other.startAddress)) continue;
    accepted.push(fde);
  }
  return accepted;
}

export function parseElfUnwind(buffer: ArrayBuffer, sections: ElfSection[]): ElfUnwindModel {
  const ehFrame = sections.find((section) => section.name === '.eh_frame' && section.size > 0);
  const debugFrame = sections.find((section) => section.name === '.debug_frame' && section.size > 0);
  if (!ehFrame && !debugFrame) return { available: false, fdes: [], errors: [] };

  const fdes: ElfUnwindFde[] = [];
  const errors: string[] = [];
  if (ehFrame) {
    const parsed = parseEhFrame(buffer, ehFrame, sections);
    fdes.push(...parsed.fdes);
    errors.push(...parsed.errors);
  }
  if (debugFrame) {
    const parsed = parseDebugFrame(buffer, debugFrame);
    fdes.push(...parsed.fdes);
    errors.push(...parsed.errors);
  }

  return {
    available: true,
    fdes: preferNonOverlappingFdes(fdes),
    errors
  };
}
