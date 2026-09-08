import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-variable-shifts-'));
const CODE = 0x100000;
const DATA = 0x110000;
const OUT = 0x120000;
const PAGE = 4096;
const VECTOR_BYTES = 32;

type ShiftOperation = Readonly<{
  name: string;
  opcode: 0x45 | 0x46 | 0x47;
  widthBytes: 4 | 8;
  kind: 'left' | 'right-logical' | 'right-arithmetic';
  w: 0 | 1;
}>;

const OPERATIONS: readonly ShiftOperation[] = [
  { name: 'VPSRLVD', opcode: 0x45, widthBytes: 4, kind: 'right-logical', w: 0 },
  { name: 'VPSRLVQ', opcode: 0x45, widthBytes: 8, kind: 'right-logical', w: 1 },
  { name: 'VPSRAVD', opcode: 0x46, widthBytes: 4, kind: 'right-arithmetic', w: 0 },
  { name: 'VPSLLVD', opcode: 0x47, widthBytes: 4, kind: 'left', w: 0 },
  { name: 'VPSLLVQ', opcode: 0x47, widthBytes: 8, kind: 'left', w: 1 }
];

function vector(values: readonly bigint[], widthBytes: 4 | 8): number[] {
  const bytes: number[] = [];
  const mask = (1n << BigInt(widthBytes * 8)) - 1n;
  for (const raw of values) {
    const value = raw & mask;
    for (let index = 0; index < widthBytes; index += 1) {
      bytes.push(Number((value >> BigInt(index * 8)) & 0xffn));
    }
  }
  assert.equal(bytes.length, VECTOR_BYTES);
  return bytes;
}

function readElement(bytes: readonly number[], offset: number, widthBytes: 4 | 8): bigint {
  let value = 0n;
  for (let index = 0; index < widthBytes; index += 1) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function expected(operation: ShiftOperation, source: readonly number[], counts: readonly number[], outputBytes = VECTOR_BYTES): number[] {
  const result = new Array<number>(outputBytes).fill(0);
  const bits = operation.widthBytes * 8;
  const width = BigInt(bits);
  const mask = (1n << width) - 1n;
  const sign = 1n << BigInt(bits - 1);

  for (let offset = 0; offset < outputBytes; offset += operation.widthBytes) {
    const value = readElement(source, offset, operation.widthBytes);
    const count = readElement(counts, offset, operation.widthBytes);
    let shifted: bigint;
    if (operation.kind === 'right-logical') {
      shifted = count >= width ? 0n : value >> count;
    } else if (operation.kind === 'left') {
      shifted = count >= width ? 0n : (value << count) & mask;
    } else {
      const signed = (value & sign) !== 0n ? value - (1n << width) : value;
      const effective = count >= width ? width - 1n : count;
      shifted = signed >> effective;
    }
    const normalized = shifted & mask;
    for (let index = 0; index < operation.widthBytes; index += 1) {
      result[offset + index] = Number((normalized >> BigInt(index * 8)) & 0xffn);
    }
  }
  return result;
}

function vexMap38(operation: ShiftOperation, dest: number, src1: number, modrm: number, width: 128 | 256 = 256): number[] {
  const third = (operation.w << 7) | (((~src1) & 0x0f) << 3) | (width === 256 ? 0x04 : 0) | 0x01;
  return [0xc4, 0xe2, third, operation.opcode, modrm];
}

function storeYmm(dest: number, displacement = 0x40): number[] {
  return [0xc5, 0xfe, 0x7f, 0x40 | (dest << 3), displacement & 0xff];
}

function sources(operation: ShiftOperation): { values: number[]; counts: number[] } {
  if (operation.widthBytes === 4) {
    return {
      values: vector([
        0x80000000n, 0xffffffffn, 0x7fffffffn, 0x12345678n,
        0x87654321n, 0x00000001n, 0x40000000n, 0xdeadbeefn
      ], 4),
      counts: vector([0n, 1n, 31n, 32n, 33n, 7n, 255n, 0xffffffffn], 4)
    };
  }
  return {
    values: vector([
      0x8000000000000000n, 0xffffffffffffffffn,
      0x7fffffffffffffffn, 0x123456789abcdef0n
    ], 8),
    counts: vector([0n, 1n, 63n, 64n], 8)
  };
}

function runRegisterCase(module: UnicornModule, operation: ShiftOperation, dest: 1 | 2 | 3): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const { values, counts } = sources(operation);
  const modrm = 0xc0 | (dest << 3) | 3; // dest, ymm3 counts
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,       // vmovdqu ymm1, [rax]
    0xc5, 0xfe, 0x6f, 0x58, 0x20, // vmovdqu ymm3, [rax+0x20]
    ...vexMap38(operation, dest, 1, modrm),
    ...storeYmm(dest)
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, values);
    engine.mem_write(DATA + 0x20, counts);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      expected(operation, values, counts),
      `${operation.name} register form failed for dest ymm${dest}`
    );
  } finally {
    engine.close();
  }
}

function runMemoryBoundaryCase(module: UnicornModule, operation: ShiftOperation): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const { values, counts } = sources(operation);
  const countAddress = DATA + PAGE - VECTOR_BYTES;
  const modrm = 0x10 | 3; // mod=00, dest=ymm2, r/m=[rbx]
  const code = [
    0xc5, 0xfe, 0x6f, 0x08, // vmovdqu ymm1, [rax]
    ...vexMap38(operation, 2, 1, modrm),
    0xc5, 0xfe, 0x7f, 0x10  // vmovdqu [rax], ymm2
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(OUT, values);
    engine.mem_write(countAddress, counts);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(OUT));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(countAddress));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(OUT, VECTOR_BYTES)],
      expected(operation, values, counts),
      `${operation.name} memory form must read exactly one YMM count vector at a page boundary`
    );
  } finally {
    engine.close();
  }
}

function runVex128ZeroUpper(module: UnicornModule): void {
  const operation = OPERATIONS.find((item) => item.name === 'VPSLLVD')!;
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const { values, counts } = sources(operation);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,       // ymm1 source
    0xc5, 0xfe, 0x6f, 0x50, 0x40, // seed ymm2 upper half nonzero
    0xc5, 0xfe, 0x6f, 0x58, 0x20, // ymm3 counts
    ...vexMap38(operation, 2, 1, 0xd3, 128),
    ...storeYmm(2, 0x60)
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, values);
    engine.mem_write(DATA + 0x20, counts);
    engine.mem_write(DATA + 0x40, new Array<number>(VECTOR_BYTES).fill(0xa5));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x60, VECTOR_BYTES)],
      [...expected(operation, values, counts, 16), ...new Array<number>(16).fill(0)],
      'VEX.128 variable shift must zero the upper YMM lane'
    );
  } finally {
    engine.close();
  }
}

function assertReservedW1ArithmeticFails(module: UnicornModule): void {
  const operation: ShiftOperation = { name: 'reserved VPSRAVQ', opcode: 0x46, widthBytes: 8, kind: 'right-arithmetic', w: 1 };
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const invalid = vexMap38(operation, 2, 1, 0xd3);
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, invalid);
    assert.throws(
      () => engine.emu_start(CODE, CODE + invalid.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      '0F38:46 with VEX.W=1 must remain fail-closed'
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

  for (const operation of OPERATIONS) {
    runRegisterCase(module, operation, 2);
    runRegisterCase(module, operation, 1); // dest aliases src1
    runRegisterCase(module, operation, 3); // dest aliases src2
    runMemoryBoundaryCase(module, operation);
  }
  runVex128ZeroUpper(module);
  assertReservedW1ArithmeticFails(module);

  console.log(
    `Unicorn AVX2 variable shift smoke: PASS (${OPERATIONS.length} instruction forms + src1/src2 aliasing + page-boundary memory + VEX.128 zero-upper + reserved W=1 rejection)`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
