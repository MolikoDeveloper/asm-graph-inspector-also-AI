import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-lane-local-'));

const CODE = 0x100000;
const DATA = 0x110000;
const PAGE = 4096;
const VECTOR_BYTES = 32;

type LaneOperation = Readonly<{
  name: string;
  opcode: number;
  expected: (left: readonly number[], right: readonly number[]) => number[];
}>;

function readUnsigned(bytes: readonly number[], offset: number, widthBytes: number): bigint {
  let value = 0n;
  for (let byte = 0; byte < widthBytes; byte += 1) {
    value |= BigInt(bytes[offset + byte]) << BigInt(byte * 8);
  }
  return value;
}

function toSigned(value: bigint, bits: number): bigint {
  const width = BigInt(bits);
  const sign = 1n << (width - 1n);
  const modulus = 1n << width;
  return (value & sign) !== 0n ? value - modulus : value;
}

function writeElement(output: number[], offset: number, widthBytes: number, value: bigint): void {
  const mask = (1n << BigInt(widthBytes * 8)) - 1n;
  const normalized = value & mask;
  for (let byte = 0; byte < widthBytes; byte += 1) {
    output[offset + byte] = Number((normalized >> BigInt(byte * 8)) & 0xffn);
  }
}

function mapElements(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2 | 4 | 8,
  operation: (a: bigint, b: bigint) => bigint
): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let offset = 0; offset < VECTOR_BYTES; offset += widthBytes) {
    writeElement(
      output,
      offset,
      widthBytes,
      operation(readUnsigned(left, offset, widthBytes), readUnsigned(right, offset, widthBytes))
    );
  }
  return output;
}

function compareElements(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2 | 4,
  mode: 'eq' | 'gt-signed'
): number[] {
  const bits = widthBytes * 8;
  const allOnes = (1n << BigInt(bits)) - 1n;
  return mapElements(left, right, widthBytes, (a, b) => {
    const matches = mode === 'eq' ? a === b : toSigned(a, bits) > toSigned(b, bits);
    return matches ? allOnes : 0n;
  });
}

function saturatingElements(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2,
  signed: boolean,
  subtract: boolean
): number[] {
  const bits = widthBytes * 8;
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  return mapElements(left, right, widthBytes, (rawA, rawB) => {
    const a = signed ? toSigned(rawA, bits) : rawA;
    const b = signed ? toSigned(rawB, bits) : rawB;
    const result = subtract ? a - b : a + b;
    return result < min ? min : result > max ? max : result;
  });
}

function minMaxElements(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2,
  signed: boolean,
  takeMax: boolean
): number[] {
  const bits = widthBytes * 8;
  return mapElements(left, right, widthBytes, (rawA, rawB) => {
    const a = signed ? toSigned(rawA, bits) : rawA;
    const b = signed ? toSigned(rawB, bits) : rawB;
    return takeMax ? (a > b ? a : b) : (a < b ? a : b);
  });
}

function averageElements(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2
): number[] {
  return mapElements(left, right, widthBytes, (a, b) => (a + b + 1n) >> 1n);
}

function multiplyLowWords(left: readonly number[], right: readonly number[]): number[] {
  return mapElements(left, right, 2, (a, b) => a * b);
}

function multiplyHighWords(
  left: readonly number[],
  right: readonly number[],
  signed: boolean
): number[] {
  return mapElements(left, right, 2, (rawA, rawB) => {
    const a = signed ? toSigned(rawA, 16) : rawA;
    const b = signed ? toSigned(rawB, 16) : rawB;
    return (a * b) >> 16n;
  });
}

function multiplyUnsignedDwords(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let dword = 0; dword < 8; dword += 2) {
    const sourceOffset = dword * 4;
    const destOffset = (dword / 2) * 8;
    writeElement(
      output,
      destOffset,
      8,
      readUnsigned(left, sourceOffset, 4) * readUnsigned(right, sourceOffset, 4)
    );
  }
  return output;
}

function multiplyAddWords(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let word = 0; word < 16; word += 2) {
    const first = word * 2;
    const second = first + 2;
    const a0 = toSigned(readUnsigned(left, first, 2), 16);
    const b0 = toSigned(readUnsigned(right, first, 2), 16);
    const a1 = toSigned(readUnsigned(left, second, 2), 16);
    const b1 = toSigned(readUnsigned(right, second, 2), 16);
    writeElement(output, (word / 2) * 4, 4, a0 * b0 + a1 * b1);
  }
  return output;
}

function sumAbsoluteByteDifferences(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let group = 0; group < 4; group += 1) {
    let sum = 0n;
    const offset = group * 8;
    for (let byte = 0; byte < 8; byte += 1) {
      const a = BigInt(left[offset + byte]);
      const b = BigInt(right[offset + byte]);
      sum += a >= b ? a - b : b - a;
    }
    writeElement(output, offset, 8, sum);
  }
  return output;
}

const OPERATIONS: ReadonlyArray<LaneOperation> = [
  { name: 'VPCMPGTB', opcode: 0x64, expected: (a, b) => compareElements(a, b, 1, 'gt-signed') },
  { name: 'VPCMPGTW', opcode: 0x65, expected: (a, b) => compareElements(a, b, 2, 'gt-signed') },
  { name: 'VPCMPGTD', opcode: 0x66, expected: (a, b) => compareElements(a, b, 4, 'gt-signed') },
  { name: 'VPCMPEQB', opcode: 0x74, expected: (a, b) => compareElements(a, b, 1, 'eq') },
  { name: 'VPCMPEQW', opcode: 0x75, expected: (a, b) => compareElements(a, b, 2, 'eq') },
  { name: 'VPCMPEQD', opcode: 0x76, expected: (a, b) => compareElements(a, b, 4, 'eq') },
  { name: 'VPMULLW', opcode: 0xd5, expected: multiplyLowWords },
  { name: 'VPSUBUSB', opcode: 0xd8, expected: (a, b) => saturatingElements(a, b, 1, false, true) },
  { name: 'VPSUBUSW', opcode: 0xd9, expected: (a, b) => saturatingElements(a, b, 2, false, true) },
  { name: 'VPMINUB', opcode: 0xda, expected: (a, b) => minMaxElements(a, b, 1, false, false) },
  { name: 'VPADDUSB', opcode: 0xdc, expected: (a, b) => saturatingElements(a, b, 1, false, false) },
  { name: 'VPADDUSW', opcode: 0xdd, expected: (a, b) => saturatingElements(a, b, 2, false, false) },
  { name: 'VPMAXUB', opcode: 0xde, expected: (a, b) => minMaxElements(a, b, 1, false, true) },
  { name: 'VPAVGB', opcode: 0xe0, expected: (a, b) => averageElements(a, b, 1) },
  { name: 'VPAVGW', opcode: 0xe3, expected: (a, b) => averageElements(a, b, 2) },
  { name: 'VPMULHUW', opcode: 0xe4, expected: (a, b) => multiplyHighWords(a, b, false) },
  { name: 'VPMULHW', opcode: 0xe5, expected: (a, b) => multiplyHighWords(a, b, true) },
  { name: 'VPSUBSB', opcode: 0xe8, expected: (a, b) => saturatingElements(a, b, 1, true, true) },
  { name: 'VPSUBSW', opcode: 0xe9, expected: (a, b) => saturatingElements(a, b, 2, true, true) },
  { name: 'VPMINSW', opcode: 0xea, expected: (a, b) => minMaxElements(a, b, 2, true, false) },
  { name: 'VPADDSB', opcode: 0xec, expected: (a, b) => saturatingElements(a, b, 1, true, false) },
  { name: 'VPADDSW', opcode: 0xed, expected: (a, b) => saturatingElements(a, b, 2, true, false) },
  { name: 'VPMAXSW', opcode: 0xee, expected: (a, b) => minMaxElements(a, b, 2, true, true) },
  { name: 'VPMULUDQ', opcode: 0xf4, expected: multiplyUnsignedDwords },
  { name: 'VPMADDWD', opcode: 0xf5, expected: multiplyAddWords },
  { name: 'VPSADBW', opcode: 0xf6, expected: sumAbsoluteByteDifferences }
];

function runOperation(
  module: UnicornModule,
  operation: LaneOperation,
  sourceA: readonly number[],
  sourceB: readonly number[]
): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,             // vmovdqu ymm1, [rax]
    0xc5, 0xfe, 0x6f, 0x50, 0x20,       // vmovdqu ymm2, [rax+0x20]
    0xc5, 0xf5, operation.opcode, 0xc2,  // op ymm0, ymm1, ymm2
    0xc5, 0xfe, 0x7f, 0x40, 0x40        // vmovdqu [rax+0x40], ymm0
  ];

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, sourceA);
    engine.mem_write(DATA + 0x20, sourceB);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);

    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      operation.expected(sourceA, sourceB),
      `${operation.name} must produce exact 256-bit lane-local semantics`
    );
  } finally {
    engine.close();
  }
}

function assertCrossLaneStillFailsClosed(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const unsupported = [0xc4, 0xe2, 0x75, 0x36, 0xc2]; // vpermd ymm0, ymm1, ymm2
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, unsupported);
    assert.throws(
      () => engine.emu_start(CODE, CODE + unsupported.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      'cross-lane VPERMD must remain fail-closed until dedicated lowering exists'
    );
  } finally {
    engine.close();
  }
}

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const module = await factory();

  // Repeated edge-heavy bytes deliberately exercise signed negatives, equality,
  // saturation, carry/borrow, high-half multiply and pairwise multiply-add.
  const sourceA = Array.from({ length: VECTOR_BYTES }, (_, index) =>
    [0xff, 0x7f, 0x00, 0x80, 0xfe, 0x01, 0xaa, 0x55, 0x34, 0x12, 0xcc, 0xed, 0x00, 0x80, 0xff, 0x7f][index % 16]
  );
  const sourceB = Array.from({ length: VECTOR_BYTES }, (_, index) =>
    [0x02, 0x81, 0xff, 0x80, 0x05, 0xff, 0x0f, 0xf0, 0x34, 0x12, 0x01, 0x80, 0xff, 0x7f, 0x00, 0x80][index % 16]
  );

  for (const operation of OPERATIONS) {
    runOperation(module, operation, sourceA, sourceB);
  }
  assertCrossLaneStillFailsClosed(module);

  console.log(
    `Unicorn AVX2 lane-local smoke: PASS (${OPERATIONS.length} compare/saturating/minmax/multiply/average/SAD ops + fail-closed VPERMD)`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
