import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-extend-'));
const CODE = 0x100000;
const DATA = 0x110000;
const PAGE = 4096;
const VECTOR_BYTES = 32;

type ExtendOperation = Readonly<{
  name: string;
  opcode: number;
  inputWidth: 1 | 2 | 4;
  outputWidth: 2 | 4 | 8;
  signed: boolean;
}>;

const OPERATIONS: readonly ExtendOperation[] = [
  { name: 'VPMOVSXBW', opcode: 0x20, inputWidth: 1, outputWidth: 2, signed: true },
  { name: 'VPMOVSXBD', opcode: 0x21, inputWidth: 1, outputWidth: 4, signed: true },
  { name: 'VPMOVSXBQ', opcode: 0x22, inputWidth: 1, outputWidth: 8, signed: true },
  { name: 'VPMOVSXWD', opcode: 0x23, inputWidth: 2, outputWidth: 4, signed: true },
  { name: 'VPMOVSXWQ', opcode: 0x24, inputWidth: 2, outputWidth: 8, signed: true },
  { name: 'VPMOVSXDQ', opcode: 0x25, inputWidth: 4, outputWidth: 8, signed: true },
  { name: 'VPMOVZXBW', opcode: 0x30, inputWidth: 1, outputWidth: 2, signed: false },
  { name: 'VPMOVZXBD', opcode: 0x31, inputWidth: 1, outputWidth: 4, signed: false },
  { name: 'VPMOVZXBQ', opcode: 0x32, inputWidth: 1, outputWidth: 8, signed: false },
  { name: 'VPMOVZXWD', opcode: 0x33, inputWidth: 2, outputWidth: 4, signed: false },
  { name: 'VPMOVZXWQ', opcode: 0x34, inputWidth: 2, outputWidth: 8, signed: false },
  { name: 'VPMOVZXDQ', opcode: 0x35, inputWidth: 4, outputWidth: 8, signed: false }
];

function sourceBytesFor(operation: ExtendOperation, outputBytes = VECTOR_BYTES): number {
  return (outputBytes / operation.outputWidth) * operation.inputWidth;
}

function readUnsigned(bytes: readonly number[], offset: number, width: number): bigint {
  let value = 0n;
  for (let index = 0; index < width; index += 1) {
    value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  }
  return value;
}

function toSigned(value: bigint, bits: number): bigint {
  const sign = 1n << BigInt(bits - 1);
  return (value & sign) === 0n ? value : value - (1n << BigInt(bits));
}

function writeValue(output: number[], offset: number, width: number, value: bigint): void {
  const mask = (1n << BigInt(width * 8)) - 1n;
  const normalized = value & mask;
  for (let index = 0; index < width; index += 1) {
    output[offset + index] = Number((normalized >> BigInt(index * 8)) & 0xffn);
  }
}

function expected(operation: ExtendOperation, source: readonly number[], outputBytes = VECTOR_BYTES): number[] {
  const output = new Array<number>(outputBytes).fill(0);
  const elements = outputBytes / operation.outputWidth;
  for (let element = 0; element < elements; element += 1) {
    const raw = readUnsigned(source, element * operation.inputWidth, operation.inputWidth);
    const value = operation.signed ? toSigned(raw, operation.inputWidth * 8) : raw;
    writeValue(output, element * operation.outputWidth, operation.outputWidth, value);
  }
  return output;
}

function vexMap38(opcode: number, modrm: number, displacement?: number, width: 128 | 256 = 256): number[] {
  // W=0, map=0F38, pp=66, reserved vvvv=1111b. QEMU decodes that vvvv as zero.
  const third = width === 256 ? 0x7d : 0x79;
  return displacement === undefined
    ? [0xc4, 0xe2, third, opcode, modrm]
    : [0xc4, 0xe2, third, opcode, modrm, displacement & 0xff];
}

function makeSource(): number[] {
  return [
    0x80, 0x7f, 0xff, 0x01, 0x00, 0xfe, 0x40, 0xc0,
    0x34, 0x12, 0xcc, 0xed, 0x00, 0x80, 0xff, 0x7f,
    0x78, 0x56, 0x34, 0x12, 0x88, 0xa9, 0xcb, 0xed,
    0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd
  ];
}

function runRegisterAliasing(module: UnicornModule, operation: ExtendOperation, source: readonly number[]): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,                // vmovdqu ymm1, [rax]
    ...vexMap38(operation.opcode, 0xc9),    // op ymm1, xmm1 (dest aliases narrow source)
    0xc5, 0xfe, 0x7f, 0x48, 0x40           // vmovdqu [rax+0x40], ymm1
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      expected(operation, source),
      `${operation.name} must preserve its source when destination aliases it`
    );
  } finally {
    engine.close();
  }
}

function runExactMemoryWidth(module: UnicornModule, operation: ExtendOperation, source: readonly number[]): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const sourceBytes = sourceBytesFor(operation);
  const sourceAddress = DATA + PAGE - sourceBytes;
  const code = [
    ...vexMap38(operation.opcode, 0x10), // op ymm2, [rax]
    0xc5, 0xfe, 0x7f, 0x13              // vmovdqu [rbx], ymm2
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(sourceAddress, source.slice(0, sourceBytes));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(sourceAddress));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA, VECTOR_BYTES)],
      expected(operation, source),
      `${operation.name} memory form must read exactly ${sourceBytes} source bytes`
    );
  } finally {
    engine.close();
  }
}

function runVex128ZeroUpper(module: UnicornModule, source: readonly number[]): void {
  const operation = OPERATIONS[0]; // VPMOVSXBW
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,                          // seed all of ymm1
    ...vexMap38(operation.opcode, 0xc9, undefined, 128), // vpmovsxbw xmm1, xmm1
    0xc5, 0xfe, 0x7f, 0x48, 0x40                     // observe full ymm1
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      [...expected(operation, source, 16), ...new Array<number>(16).fill(0)],
      'VEX.128 packed extension must zero the upper YMM lane'
    );
  } finally {
    engine.close();
  }
}

function assertReservedVvvvFailsClosed(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  // Same VPMOVSXBW encoding, but VEX.vvvv names ymm1 instead of reserved 1111b.
  const invalid = [0xc4, 0xe2, 0x75, 0x20, 0xc1];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, invalid);
    assert.throws(
      () => engine.emu_start(CODE, CODE + invalid.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      'reserved VEX.vvvv encodings must remain fail-closed'
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
  const source = makeSource();

  for (const operation of OPERATIONS) {
    runRegisterAliasing(module, operation, source);
    runExactMemoryWidth(module, operation, source);
  }
  runVex128ZeroUpper(module, source);
  assertReservedVvvvFailsClosed(module);

  console.log(
    `Unicorn AVX2 extension smoke: PASS (${OPERATIONS.length} sign/zero-extension ops + aliasing + exact-width memory + VEX.128 zero-upper + reserved-vvvv rejection)`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
