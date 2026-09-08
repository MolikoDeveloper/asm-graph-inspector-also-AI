import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-map38-'));
const CODE = 0x100000;
const DATA = 0x110000;
const PAGE = 4096;
const VECTOR_BYTES = 32;
const LANE_BYTES = 16;

type Operation = Readonly<{
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
  const sign = 1n << BigInt(bits - 1);
  const modulus = 1n << BigInt(bits);
  return (value & sign) !== 0n ? value - modulus : value;
}

function writeElement(output: number[], offset: number, widthBytes: number, value: bigint): void {
  const mask = (1n << BigInt(widthBytes * 8)) - 1n;
  const normalized = value & mask;
  for (let byte = 0; byte < widthBytes; byte += 1) {
    output[offset + byte] = Number((normalized >> BigInt(byte * 8)) & 0xffn);
  }
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  return value < min ? min : value > max ? max : value;
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

function horizontal(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 2 | 4,
  subtract: boolean,
  saturating: boolean
): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  const bits = widthBytes * 8;
  const pairsPerSourceLane = LANE_BYTES / widthBytes / 2;
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;

  for (let lane = 0; lane < 2; lane += 1) {
    const laneBase = lane * LANE_BYTES;
    let destElement = 0;
    for (const source of [left, right] as const) {
      for (let pair = 0; pair < pairsPerSourceLane; pair += 1) {
        const firstOffset = laneBase + pair * widthBytes * 2;
        const secondOffset = firstOffset + widthBytes;
        const first = toSigned(readUnsigned(source, firstOffset, widthBytes), bits);
        const second = toSigned(readUnsigned(source, secondOffset, widthBytes), bits);
        let value = subtract ? first - second : first + second;
        if (saturating) value = clamp(value, min, max);
        writeElement(output, laneBase + destElement * widthBytes, widthBytes, value);
        destElement += 1;
      }
    }
  }
  return output;
}

function shuffleBytes(left: readonly number[], masks: readonly number[]): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let lane = 0; lane < 2; lane += 1) {
    const laneBase = lane * LANE_BYTES;
    for (let index = 0; index < LANE_BYTES; index += 1) {
      const mask = masks[laneBase + index];
      output[laneBase + index] = (mask & 0x80) !== 0
        ? 0
        : left[laneBase + (mask & 0x0f)];
    }
  }
  return output;
}

function multiplyAddUnsignedSignedBytes(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let offset = 0; offset < VECTOR_BYTES; offset += 2) {
    const a0 = BigInt(left[offset]);
    const a1 = BigInt(left[offset + 1]);
    const b0 = toSigned(BigInt(right[offset]), 8);
    const b1 = toSigned(BigInt(right[offset + 1]), 8);
    const value = clamp(a0 * b0 + a1 * b1, -32768n, 32767n);
    writeElement(output, offset, 2, value);
  }
  return output;
}

function signElements(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2 | 4
): number[] {
  const bits = widthBytes * 8;
  return mapElements(left, right, widthBytes, (rawValue, rawSign) => {
    const sign = toSigned(rawSign, bits);
    if (sign === 0n) return 0n;
    return sign < 0n ? -toSigned(rawValue, bits) : rawValue;
  });
}

function multiplyRoundScaleWords(left: readonly number[], right: readonly number[]): number[] {
  return mapElements(left, right, 2, (rawA, rawB) => {
    const product = toSigned(rawA, 16) * toSigned(rawB, 16);
    return (product + 0x4000n) >> 15n;
  });
}

function multiplySignedDwordsToQwords(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let lane = 0; lane < 2; lane += 1) {
    const laneBase = lane * LANE_BYTES;
    for (let element = 0; element < 2; element += 1) {
      const sourceOffset = laneBase + element * 8;
      const a = toSigned(readUnsigned(left, sourceOffset, 4), 32);
      const b = toSigned(readUnsigned(right, sourceOffset, 4), 32);
      writeElement(output, laneBase + element * 8, 8, a * b);
    }
  }
  return output;
}

function compareElements(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 8,
  mode: 'eq' | 'gt-signed'
): number[] {
  const allOnes = (1n << BigInt(widthBytes * 8)) - 1n;
  return mapElements(left, right, widthBytes, (a, b) => {
    const matches = mode === 'eq' ? a === b : toSigned(a, 64) > toSigned(b, 64);
    return matches ? allOnes : 0n;
  });
}

function packSignedDwordsToUnsignedWords(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  for (let lane = 0; lane < 2; lane += 1) {
    const laneBase = lane * LANE_BYTES;
    let dest = 0;
    for (const source of [left, right] as const) {
      for (let element = 0; element < 4; element += 1) {
        const value = toSigned(readUnsigned(source, laneBase + element * 4, 4), 32);
        writeElement(output, laneBase + dest * 2, 2, clamp(value, 0n, 65535n));
        dest += 1;
      }
    }
  }
  return output;
}

function minMax(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2 | 4,
  signed: boolean,
  maximum: boolean
): number[] {
  const bits = widthBytes * 8;
  return mapElements(left, right, widthBytes, (rawA, rawB) => {
    const a = signed ? toSigned(rawA, bits) : rawA;
    const b = signed ? toSigned(rawB, bits) : rawB;
    return maximum ? (a > b ? a : b) : (a < b ? a : b);
  });
}

function multiplyLowDwords(left: readonly number[], right: readonly number[]): number[] {
  return mapElements(left, right, 4, (a, b) => a * b);
}

const OPERATIONS: readonly Operation[] = [
  { name: 'VPSHUFB', opcode: 0x00, expected: shuffleBytes },
  { name: 'VPHADDW', opcode: 0x01, expected: (a, b) => horizontal(a, b, 2, false, false) },
  { name: 'VPHADDD', opcode: 0x02, expected: (a, b) => horizontal(a, b, 4, false, false) },
  { name: 'VPHADDSW', opcode: 0x03, expected: (a, b) => horizontal(a, b, 2, false, true) },
  { name: 'VPMADDUBSW', opcode: 0x04, expected: multiplyAddUnsignedSignedBytes },
  { name: 'VPHSUBW', opcode: 0x05, expected: (a, b) => horizontal(a, b, 2, true, false) },
  { name: 'VPHSUBD', opcode: 0x06, expected: (a, b) => horizontal(a, b, 4, true, false) },
  { name: 'VPHSUBSW', opcode: 0x07, expected: (a, b) => horizontal(a, b, 2, true, true) },
  { name: 'VPSIGNB', opcode: 0x08, expected: (a, b) => signElements(a, b, 1) },
  { name: 'VPSIGNW', opcode: 0x09, expected: (a, b) => signElements(a, b, 2) },
  { name: 'VPSIGND', opcode: 0x0a, expected: (a, b) => signElements(a, b, 4) },
  { name: 'VPMULHRSW', opcode: 0x0b, expected: multiplyRoundScaleWords },
  { name: 'VPMULDQ', opcode: 0x28, expected: multiplySignedDwordsToQwords },
  { name: 'VPCMPEQQ', opcode: 0x29, expected: (a, b) => compareElements(a, b, 8, 'eq') },
  { name: 'VPACKUSDW', opcode: 0x2b, expected: packSignedDwordsToUnsignedWords },
  { name: 'VPCMPGTQ', opcode: 0x37, expected: (a, b) => compareElements(a, b, 8, 'gt-signed') },
  { name: 'VPMINSB', opcode: 0x38, expected: (a, b) => minMax(a, b, 1, true, false) },
  { name: 'VPMINSD', opcode: 0x39, expected: (a, b) => minMax(a, b, 4, true, false) },
  { name: 'VPMINUW', opcode: 0x3a, expected: (a, b) => minMax(a, b, 2, false, false) },
  { name: 'VPMINUD', opcode: 0x3b, expected: (a, b) => minMax(a, b, 4, false, false) },
  { name: 'VPMAXSB', opcode: 0x3c, expected: (a, b) => minMax(a, b, 1, true, true) },
  { name: 'VPMAXSD', opcode: 0x3d, expected: (a, b) => minMax(a, b, 4, true, true) },
  { name: 'VPMAXUW', opcode: 0x3e, expected: (a, b) => minMax(a, b, 2, false, true) },
  { name: 'VPMAXUD', opcode: 0x3f, expected: (a, b) => minMax(a, b, 4, false, true) },
  { name: 'VPMULLD', opcode: 0x40, expected: multiplyLowDwords }
];

function map38(opcode: number, modrm: number, displacement?: number): number[] {
  return displacement === undefined
    ? [0xc4, 0xe2, 0x75, opcode, modrm]
    : [0xc4, 0xe2, 0x75, opcode, modrm, displacement & 0xff];
}

function runOperation(
  module: UnicornModule,
  operation: Operation,
  sourceA: readonly number[],
  sourceB: readonly number[]
): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,              // vmovdqu ymm1, [rax]
    0xc5, 0xfe, 0x6f, 0x50, 0x20,        // vmovdqu ymm2, [rax+0x20]
    ...map38(operation.opcode, 0xc2),      // op ymm0, ymm1, ymm2
    0xc5, 0xfe, 0x7f, 0x40, 0x40         // vmovdqu [rax+0x40], ymm0
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
      `${operation.name} must produce exact AVX2 0F38 256-bit semantics`
    );
  } finally {
    engine.close();
  }
}

function runAliasingAndMemory(module: UnicornModule, sourceA: readonly number[], sourceB: readonly number[]): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const operation = OPERATIONS.find((item) => item.name === 'VPMULLD')!;
  const expected = operation.expected(sourceA, sourceB);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,              // vmovdqu ymm1, [rax]
    0xc5, 0xfe, 0x6f, 0x50, 0x20,        // vmovdqu ymm2, [rax+0x20]
    ...map38(operation.opcode, 0xd2),      // vpmulld ymm2, ymm1, ymm2 (dest==src2)
    0xc5, 0xfe, 0x7f, 0x50, 0x40,        // vmovdqu [rax+0x40], ymm2
    ...map38(operation.opcode, 0x58, 0x20), // vpmulld ymm3, ymm1, [rax+0x20]
    0xc5, 0xfe, 0x7f, 0x58, 0x60         // vmovdqu [rax+0x60], ymm3
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, sourceA);
    engine.mem_write(DATA + 0x20, sourceB);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual([...engine.mem_read(DATA + 0x40, VECTOR_BYTES)], expected, '0F38 dest==src2 must snapshot source2');
    assert.deepEqual([...engine.mem_read(DATA + 0x60, VECTOR_BYTES)], expected, '0F38 memory source must cover both YMM lanes');
  } finally {
    engine.close();
  }
}

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const module = await factory();

  // Values include negative signed elements, equality, saturation edges,
  // non-trivial shuffle masks and multiplication overflow without the singular
  // VPMULHRSW -32768 * -32768 corner so the independent formula stays clear.
  const sourceA = Array.from({ length: VECTOR_BYTES }, (_, index) =>
    [0x7f, 0x01, 0x80, 0xfe, 0x34, 0x12, 0xcc, 0xed, 0xff, 0x7f, 0x10, 0x00, 0x00, 0x40, 0xfe, 0xff][index % 16]
  );
  const sourceB = Array.from({ length: VECTOR_BYTES }, (_, index) =>
    [0x02, 0xff, 0x01, 0x80, 0x34, 0x12, 0x01, 0x00, 0x80, 0x00, 0x0f, 0x8f, 0x00, 0x20, 0xff, 0x7f][index % 16]
  );

  for (const operation of OPERATIONS) runOperation(module, operation, sourceA, sourceB);
  runAliasingAndMemory(module, sourceA, sourceB);

  console.log(`Unicorn AVX2 0F38 smoke: PASS (${OPERATIONS.length} explicit binary ops + aliasing + memory source)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
