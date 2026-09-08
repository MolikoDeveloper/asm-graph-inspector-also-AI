import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-pack-'));
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
  for (let i = 0; i < widthBytes; i += 1) value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
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
  for (let i = 0; i < widthBytes; i += 1) output[offset + i] = Number((normalized >> BigInt(i * 8)) & 0xffn);
}

function unpack(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2 | 4 | 8,
  high: boolean
): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  const elementsPerLane = LANE_BYTES / widthBytes;
  const half = elementsPerLane / 2;
  for (let lane = 0; lane < 2; lane += 1) {
    const laneBase = lane * LANE_BYTES;
    const first = high ? half : 0;
    for (let i = 0; i < half; i += 1) {
      const sourceOffset = laneBase + (first + i) * widthBytes;
      const destOffset = laneBase + i * widthBytes * 2;
      for (let byte = 0; byte < widthBytes; byte += 1) {
        output[destOffset + byte] = left[sourceOffset + byte];
        output[destOffset + widthBytes + byte] = right[sourceOffset + byte];
      }
    }
  }
  return output;
}

function packSigned(
  left: readonly number[],
  right: readonly number[],
  sourceWidth: 2 | 4,
  destWidth: 1 | 2,
  unsignedDestination: boolean
): number[] {
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  const sourceBits = sourceWidth * 8;
  const destBits = destWidth * 8;
  const min = unsignedDestination ? 0n : -(1n << BigInt(destBits - 1));
  const max = unsignedDestination ? (1n << BigInt(destBits)) - 1n : (1n << BigInt(destBits - 1)) - 1n;
  const sourceElementsPerLane = LANE_BYTES / sourceWidth;

  for (let lane = 0; lane < 2; lane += 1) {
    const laneBase = lane * LANE_BYTES;
    const sources = [left, right] as const;
    let destElement = 0;
    for (const source of sources) {
      for (let i = 0; i < sourceElementsPerLane; i += 1) {
        const raw = readUnsigned(source, laneBase + i * sourceWidth, sourceWidth);
        const signed = toSigned(raw, sourceBits);
        const clamped = signed < min ? min : signed > max ? max : signed;
        writeElement(output, laneBase + destElement * destWidth, destWidth, clamped);
        destElement += 1;
      }
    }
  }
  return output;
}

const OPERATIONS: readonly Operation[] = [
  { name: 'VPUNPCKLBW', opcode: 0x60, expected: (a, b) => unpack(a, b, 1, false) },
  { name: 'VPUNPCKLWD', opcode: 0x61, expected: (a, b) => unpack(a, b, 2, false) },
  { name: 'VPUNPCKLDQ', opcode: 0x62, expected: (a, b) => unpack(a, b, 4, false) },
  { name: 'VPACKSSWB', opcode: 0x63, expected: (a, b) => packSigned(a, b, 2, 1, false) },
  { name: 'VPACKUSWB', opcode: 0x67, expected: (a, b) => packSigned(a, b, 2, 1, true) },
  { name: 'VPUNPCKHBW', opcode: 0x68, expected: (a, b) => unpack(a, b, 1, true) },
  { name: 'VPUNPCKHWD', opcode: 0x69, expected: (a, b) => unpack(a, b, 2, true) },
  { name: 'VPUNPCKHDQ', opcode: 0x6a, expected: (a, b) => unpack(a, b, 4, true) },
  { name: 'VPACKSSDW', opcode: 0x6b, expected: (a, b) => packSigned(a, b, 4, 2, false) },
  { name: 'VPUNPCKLQDQ', opcode: 0x6c, expected: (a, b) => unpack(a, b, 8, false) },
  { name: 'VPUNPCKHQDQ', opcode: 0x6d, expected: (a, b) => unpack(a, b, 8, true) }
];

function runOperation(module: UnicornModule, operation: Operation, left: readonly number[], right: readonly number[]): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,
    0xc5, 0xfe, 0x6f, 0x50, 0x20,
    0xc5, 0xf5, operation.opcode, 0xc2,
    0xc5, 0xfe, 0x7f, 0x40, 0x40
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, left);
    engine.mem_write(DATA + 0x20, right);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      operation.expected(left, right),
      `${operation.name} must preserve AVX2 per-128-bit-lane ordering and saturation`
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

  const left = Array.from({ length: VECTOR_BYTES }, (_, i) =>
    [0x00, 0x80, 0x7f, 0xff, 0x34, 0x12, 0xcc, 0xed, 0xff, 0x7f, 0x00, 0x80, 0x01, 0x00, 0xfe, 0xff][i % 16]
  );
  const right = Array.from({ length: VECTOR_BYTES }, (_, i) =>
    [0xff, 0x00, 0x80, 0x7f, 0x78, 0x56, 0x00, 0x01, 0x00, 0xff, 0xff, 0x00, 0x10, 0x00, 0xf0, 0xff][i % 16]
  );

  for (const operation of OPERATIONS) runOperation(module, operation, left, right);
  console.log(`Unicorn AVX2 pack/unpack smoke: PASS (${OPERATIONS.length} explicit lane-local interleave/pack ops)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
