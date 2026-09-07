import { inspectElfSymbolVersions } from '../../src/features/binary/elfSymbolVersions';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function syntheticVersionedElf(): ArrayBuffer {
  const size = 0x600;
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const base = 0x400000;

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 3, true);
  view.setUint16(18, 62, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 2, true);

  // PT_LOAD covering the synthetic file.
  view.setUint32(64, 1, true);
  view.setUint32(68, 4, true);
  view.setBigUint64(72, 0n, true);
  view.setBigUint64(80, BigInt(base), true);
  view.setBigUint64(88, BigInt(base), true);
  view.setBigUint64(96, BigInt(size), true);
  view.setBigUint64(104, BigInt(size), true);
  view.setBigUint64(112, 0x1000n, true);

  const dynamicOffset = 0x200;
  const dynamicAddress = base + dynamicOffset;
  view.setUint32(120, 2, true);
  view.setUint32(124, 4, true);
  view.setBigUint64(128, BigInt(dynamicOffset), true);
  view.setBigUint64(136, BigInt(dynamicAddress), true);
  view.setBigUint64(144, BigInt(dynamicAddress), true);
  view.setBigUint64(152, BigInt(7 * 16), true);
  view.setBigUint64(160, BigInt(7 * 16), true);
  view.setBigUint64(168, 8n, true);

  const strings = ['','libc.so.6','GLIBC_2.34','GLIBC_2.36'];
  const stringOffsets = new Map<string, number>();
  let stringCursor = 0x300;
  for (const value of strings) {
    stringOffsets.set(value, stringCursor - 0x300);
    const encoded = new TextEncoder().encode(value);
    bytes.set(encoded, stringCursor);
    stringCursor += encoded.length;
    bytes[stringCursor++] = 0;
  }
  const stringTableSize = stringCursor - 0x300;

  const verneedOffset = 0x380;
  const verdefOffset = 0x3c0;
  const tags: Array<[number, number]> = [
    [5, base + 0x300],
    [10, stringTableSize],
    [0x6ffffffe, base + verneedOffset],
    [0x6fffffff, 1],
    [0x6ffffffc, base + verdefOffset],
    [0x6ffffffd, 2],
    [0, 0]
  ];
  tags.forEach(([tag, value], index) => {
    const offset = dynamicOffset + index * 16;
    view.setBigInt64(offset, BigInt(tag), true);
    view.setBigUint64(offset + 8, BigInt(value), true);
  });

  // Elf64_Verneed + two Elf64_Vernaux records.
  view.setUint16(verneedOffset, 1, true);
  view.setUint16(verneedOffset + 2, 2, true);
  view.setUint32(verneedOffset + 4, stringOffsets.get('libc.so.6')!, true);
  view.setUint32(verneedOffset + 8, 16, true);
  view.setUint32(verneedOffset + 12, 0, true);
  const needAux1 = verneedOffset + 16;
  view.setUint32(needAux1 + 8, stringOffsets.get('GLIBC_2.34')!, true);
  view.setUint32(needAux1 + 12, 16, true);
  const needAux2 = needAux1 + 16;
  view.setUint32(needAux2 + 8, stringOffsets.get('GLIBC_2.36')!, true);
  view.setUint32(needAux2 + 12, 0, true);

  // Two Elf64_Verdef records, each with its first Verdaux version name.
  const writeDefinition = (offset: number, name: string, next: number) => {
    view.setUint16(offset, 1, true);
    view.setUint16(offset + 2, 0, true);
    view.setUint16(offset + 4, 1, true);
    view.setUint16(offset + 6, 1, true);
    view.setUint32(offset + 8, 0, true);
    view.setUint32(offset + 12, 20, true);
    view.setUint32(offset + 16, next, true);
    view.setUint32(offset + 20, stringOffsets.get(name)!, true);
    view.setUint32(offset + 24, 0, true);
  };
  writeDefinition(verdefOffset, 'GLIBC_2.34', 28);
  writeDefinition(verdefOffset + 28, 'GLIBC_2.36', 0);

  return buffer;
}

const summary = inspectElfSymbolVersions(syntheticVersionedElf());
assert(summary.requirements.length === 1, `expected one versioned dependency, got ${summary.requirements.length}`);
assert(summary.requirements[0].library === 'libc.so.6', `unexpected versioned library ${summary.requirements[0].library}`);
assert(summary.requirements[0].versions.join(',') === 'GLIBC_2.34,GLIBC_2.36', `unexpected requirements ${summary.requirements[0].versions.join(',')}`);
assert(summary.definitions.join(',') === 'GLIBC_2.34,GLIBC_2.36', `unexpected definitions ${summary.definitions.join(',')}`);

console.log('ELF GNU symbol-version smoke: PASS');
