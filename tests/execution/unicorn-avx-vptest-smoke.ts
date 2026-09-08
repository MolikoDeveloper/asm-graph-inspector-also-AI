import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx-vptest-'));
const CODE = 0x100000;
const DATA = 0x110000;
const OUT = 0x120000;
const PAGE = 4096;

function appendFlagCapture(code: number[]): void {
  code.push(
    0x0f, 0x94, 0xc0,       // setz al
    0x0f, 0x92, 0xc3,       // setc bl
    0x88, 0x02,             // mov [rdx], al
    0x88, 0x5a, 0x01        // mov [rdx+1], bl
  );
}

function runYmmRegisterAggregation(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const left = new Array<number>(32).fill(0);
  const right = new Array<number>(32).fill(0);
  left[16] = 0x80;
  right[16] = 0x80;
  const code = [
    0xc5, 0xfe, 0x6f, 0x00,       // vmovdqu ymm0, [rax]
    0xc5, 0xfe, 0x6f, 0x48, 0x20, // vmovdqu ymm1, [rax+0x20]
    0xc4, 0xe2, 0x7d, 0x17, 0xc1  // vptest ymm0, ymm1
  ];
  appendFlagCapture(code);

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, left);
    engine.mem_write(DATA + 0x20, right);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);

    assert.deepEqual(
      [...engine.mem_read(OUT, 2)],
      [0, 1],
      'VPTEST ymm must include the high 128-bit lane when computing ZF/CF'
    );
  } finally {
    engine.close();
  }
}

function runYmmMemoryAggregation(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const left = new Array<number>(32).fill(0);
  const right = new Array<number>(32).fill(0);
  right[31] = 0x01;
  const source = DATA + PAGE - 32;
  const code = [
    0xc5, 0xfe, 0x6f, 0x00,       // vmovdqu ymm0, [rax]
    0xc4, 0xe2, 0x7d, 0x17, 0x03  // vptest ymm0, [rbx]
  ];
  appendFlagCapture(code);

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, left);
    engine.mem_write(source, right);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(source));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);

    assert.deepEqual(
      [...engine.mem_read(OUT, 2)],
      [1, 0],
      'VPTEST ymm memory source must aggregate the full m256 operand exactly once'
    );
  } finally {
    engine.close();
  }
}

function runXmm(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const left = new Array<number>(16).fill(0);
  const right = new Array<number>(16).fill(0);
  left[15] = 0x40;
  right[15] = 0x40;
  const code = [
    0xc5, 0xfa, 0x6f, 0x00,       // vmovdqu xmm0, [rax]
    0xc5, 0xfa, 0x6f, 0x48, 0x10, // vmovdqu xmm1, [rax+0x10]
    0xc4, 0xe2, 0x79, 0x17, 0xc1  // vptest xmm0, xmm1
  ];
  appendFlagCapture(code);

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, left);
    engine.mem_write(DATA + 0x10, right);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual([...engine.mem_read(OUT, 2)], [0, 1], 'VPTEST xmm must preserve legacy PTEST flag semantics');
  } finally {
    engine.close();
  }
}

function assertReservedVvvvFails(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [0xc4, 0xe2, 0x75, 0x17, 0xc1]; // encoded vvvv != 1111b
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, code);
    assert.throws(
      () => engine.emu_start(CODE, CODE + code.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      'VPTEST with non-reserved vvvv must remain fail-closed'
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

  runYmmRegisterAggregation(module);
  runYmmMemoryAggregation(module);
  runXmm(module);
  assertReservedVvvvFails(module);

  console.log('Unicorn AVX VPTEST smoke: PASS (XMM/YMM + full-lane ZF/CF aggregation + exact m256 + reserved vvvv)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
