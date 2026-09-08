import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-packed-'));

const CODE = 0x100000;
const DATA = 0x110000;
const PAGE = 4096;
const VECTOR_BYTES = 32;

type PackedOperation = Readonly<{
  name: string;
  opcode: number;
  expected: (left: readonly number[], right: readonly number[]) => number[];
}>;

function bitwise(
  left: readonly number[],
  right: readonly number[],
  op: (a: number, b: number) => number
): number[] {
  return left.map((value, index) => op(value, right[index]) & 0xff);
}

function packedArithmetic(
  left: readonly number[],
  right: readonly number[],
  widthBytes: 1 | 2 | 4 | 8,
  subtract = false
): number[] {
  assert.equal(left.length, VECTOR_BYTES);
  assert.equal(right.length, VECTOR_BYTES);
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  const bits = BigInt(widthBytes * 8);
  const mask = (1n << bits) - 1n;

  for (let offset = 0; offset < VECTOR_BYTES; offset += widthBytes) {
    let a = 0n;
    let b = 0n;
    for (let byte = 0; byte < widthBytes; byte += 1) {
      a |= BigInt(left[offset + byte]) << BigInt(byte * 8);
      b |= BigInt(right[offset + byte]) << BigInt(byte * 8);
    }
    const value = subtract ? (a - b) & mask : (a + b) & mask;
    for (let byte = 0; byte < widthBytes; byte += 1) {
      output[offset + byte] = Number((value >> BigInt(byte * 8)) & 0xffn);
    }
  }

  return output;
}

const OPERATIONS: ReadonlyArray<PackedOperation> = [
  { name: 'VPADDQ', opcode: 0xd4, expected: (a, b) => packedArithmetic(a, b, 8) },
  { name: 'VPAND', opcode: 0xdb, expected: (a, b) => bitwise(a, b, (x, y) => x & y) },
  { name: 'VPANDN', opcode: 0xdf, expected: (a, b) => bitwise(a, b, (x, y) => (~x) & y) },
  { name: 'VPOR', opcode: 0xeb, expected: (a, b) => bitwise(a, b, (x, y) => x | y) },
  { name: 'VPXOR', opcode: 0xef, expected: (a, b) => bitwise(a, b, (x, y) => x ^ y) },
  { name: 'VPSUBB', opcode: 0xf8, expected: (a, b) => packedArithmetic(a, b, 1, true) },
  { name: 'VPSUBW', opcode: 0xf9, expected: (a, b) => packedArithmetic(a, b, 2, true) },
  { name: 'VPSUBD', opcode: 0xfa, expected: (a, b) => packedArithmetic(a, b, 4, true) },
  { name: 'VPSUBQ', opcode: 0xfb, expected: (a, b) => packedArithmetic(a, b, 8, true) },
  { name: 'VPADDB', opcode: 0xfc, expected: (a, b) => packedArithmetic(a, b, 1) },
  { name: 'VPADDW', opcode: 0xfd, expected: (a, b) => packedArithmetic(a, b, 2) },
  { name: 'VPADDD', opcode: 0xfe, expected: (a, b) => packedArithmetic(a, b, 4) }
];

function runOperation(
  module: UnicornModule,
  operation: PackedOperation,
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
      `${operation.name} must produce exact 256-bit packed semantics`
    );
  } finally {
    engine.close();
  }
}

function assertStillUnsupported(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  // VPMULLW is lane-local but intentionally not part of this increment. This
  // proves the extension is an allow-list, not a blanket VEX.L gate removal.
  const unsupported = [0xc5, 0xf5, 0xd5, 0xc2]; // vpmullw ymm0, ymm1, ymm2
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, unsupported);
    assert.throws(
      () => engine.emu_start(CODE, CODE + unsupported.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      'VPMULLW must remain fail-closed until explicitly enabled'
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

  // Values deliberately create carries, borrows and 64-bit wraparound so the
  // test catches accidental byte-wise behavior for wider element sizes.
  const sourceA = Array.from({ length: VECTOR_BYTES }, (_, index) =>
    [0xff, 0x7f, 0x00, 0x80, 0xfe, 0x01, 0xaa, 0x55][index % 8]
  );
  const sourceB = Array.from({ length: VECTOR_BYTES }, (_, index) =>
    [0x02, 0x81, 0xff, 0x80, 0x05, 0xff, 0x0f, 0xf0][index % 8]
  );

  for (const operation of OPERATIONS) {
    runOperation(module, operation, sourceA, sourceB);
  }
  assertStillUnsupported(module);

  console.log(
    `Unicorn AVX2 packed integer smoke: PASS (${OPERATIONS.length} explicit 256-bit ops + overflow/borrow semantics + fail-closed VPMULLW)`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
