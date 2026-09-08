import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-abs-'));
const CODE = 0x100000;
const DATA = 0x110000;
const PAGE = 4096;
const VECTOR_BYTES = 32;

type AbsOperation = Readonly<{
  name: string;
  opcode: number;
  width: 1 | 2 | 4;
}>;

const OPERATIONS: readonly AbsOperation[] = [
  { name: 'VPABSB', opcode: 0x1c, width: 1 },
  { name: 'VPABSW', opcode: 0x1d, width: 2 },
  { name: 'VPABSD', opcode: 0x1e, width: 4 }
];

function readUnsigned(bytes: readonly number[], offset: number, width: number): bigint {
  let value = 0n;
  for (let index = 0; index < width; index += 1) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function signed(value: bigint, bits: number): bigint {
  const sign = 1n << BigInt(bits - 1);
  return (value & sign) === 0n ? value : value - (1n << BigInt(bits));
}

function packedAbs(source: readonly number[], width: 1 | 2 | 4, outputBytes = VECTOR_BYTES): number[] {
  const output = new Array<number>(outputBytes).fill(0);
  const bits = width * 8;
  const mask = (1n << BigInt(bits)) - 1n;
  for (let offset = 0; offset < outputBytes; offset += width) {
    const value = signed(readUnsigned(source, offset, width), bits);
    const absolute = (value < 0n ? -value : value) & mask;
    for (let byte = 0; byte < width; byte += 1) {
      output[offset + byte] = Number((absolute >> BigInt(byte * 8)) & 0xffn);
    }
  }
  return output;
}

function vexMap38(opcode: number, modrm: number, width: 128 | 256 = 256): number[] {
  const third = width === 256 ? 0x7d : 0x79;
  return [0xc4, 0xe2, third, opcode, modrm];
}

function sourceBytes(): number[] {
  return [
    0x80, 0xff, 0x7f, 0x01, 0x00, 0xfe, 0x40, 0xc0,
    0x00, 0x80, 0xff, 0xff, 0xff, 0x7f, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x80, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0x7f, 0x78, 0x56, 0x34, 0xf2
  ];
}

function runRegisterAlias(module: UnicornModule, operation: AbsOperation, source: readonly number[]): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,             // vmovdqu ymm1, [rax]
    ...vexMap38(operation.opcode, 0xc9), // vpabs* ymm1, ymm1
    0xc5, 0xfe, 0x7f, 0x4b, 0x20        // vmovdqu [rbx+0x20], ymm1
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x20, VECTOR_BYTES)],
      packedAbs(source, operation.width),
      `${operation.name} register aliasing must implement exact modular absolute value`
    );
  } finally {
    engine.close();
  }
}

function runMemorySource(module: UnicornModule, operation: AbsOperation, source: readonly number[]): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    ...vexMap38(operation.opcode, 0x10), // vpabs* ymm2, [rax]
    0xc5, 0xfe, 0x7f, 0x53, 0x40        // vmovdqu [rbx+0x40], ymm2
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      packedAbs(source, operation.width),
      `${operation.name} memory source must cover both 128-bit lanes`
    );
  } finally {
    engine.close();
  }
}

function runVex128ZeroUpper(module: UnicornModule, source: readonly number[]): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,                 // seed all of ymm1
    ...vexMap38(0x1c, 0xc9, 128),            // vpabsb xmm1, xmm1
    0xc5, 0xfe, 0x7f, 0x4b, 0x60            // observe full ymm1
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x60, VECTOR_BYTES)],
      [...packedAbs(source, 1, 16), ...new Array<number>(16).fill(0)],
      'VEX.128 VPABSB must zero the upper YMM lane'
    );
  } finally {
    engine.close();
  }
}

function assertReservedVvvv(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const invalid = [0xc4, 0xe2, 0x75, 0x1c, 0xc1]; // non-reserved vvvv
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, invalid);
    assert.throws(
      () => engine.emu_start(CODE, CODE + invalid.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      'VPABS* must reject non-reserved VEX.vvvv encodings'
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
  const source = sourceBytes();

  for (const operation of OPERATIONS) {
    runRegisterAlias(module, operation, source);
    runMemorySource(module, operation, source);
  }
  runVex128ZeroUpper(module, source);
  assertReservedVvvv(module);

  console.log('Unicorn AVX2 absolute-value smoke: PASS (VPABSB/W/D + aliasing + memory + signed minima + VEX.128 zero-upper + reserved-vvvv rejection)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
