import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-basics-'));

const CODE = 0x100000;
const DATA = 0x110000;
const PAGE = 4096;

function xorBytes(left: readonly number[], right: readonly number[]): number[] {
  assert.equal(left.length, right.length);
  return left.map((value, index) => value ^ right[index]);
}

function assertBytes(actual: Uint8Array, expected: readonly number[], label: string): void {
  assert.deepEqual([...actual], [...expected], label);
}

function runSemanticClosure(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const sourceA = Array.from({ length: 32 }, (_, index) => (0x10 + index * 3) & 0xff);
  const sourceB = Array.from({ length: 32 }, (_, index) => (0xe0 - index * 5) & 0xff);
  const expected = xorBytes(sourceA, sourceB);

  const code = [
    0xc5, 0xfe, 0x6f, 0x08,                         // vmovdqu ymm1, [rax]
    0xc5, 0xfe, 0x6f, 0x50, 0x20,                   // vmovdqu ymm2, [rax+0x20]

    // Destination aliases source2. The translator must snapshot ymm2 before
    // writing the non-destructive vvvv source (ymm1) into the destination.
    0xc5, 0xf5, 0xef, 0xd2,                         // vpxor ymm2, ymm1, ymm2
    0xc5, 0xfe, 0x7f, 0x50, 0x40,                   // vmovdqu [rax+0x40], ymm2

    // Exercise a 256-bit memory operand rather than only register source2.
    0xc5, 0xf5, 0xef, 0x40, 0x20,                   // vpxor ymm0, ymm1, [rax+0x20]
    0xc5, 0xfe, 0x7f, 0x40, 0x60,                   // vmovdqu [rax+0x60], ymm0

    // Exercise the register-to-register VMOVDQU form.
    0xc5, 0xfe, 0x6f, 0xd9,                         // vmovdqu ymm3, ymm1
    0xc5, 0xfe, 0x7f, 0x98, 0x80, 0x00, 0x00, 0x00, // vmovdqu [rax+0x80], ymm3

    // Seed all 256 bits of ymm4, then perform a VEX.128 write. Architectural
    // AVX semantics require the upper 128 bits of the destination YMM to zero.
    0xc5, 0xfe, 0x6f, 0x60, 0x20,                   // vmovdqu ymm4, [rax+0x20]
    0xc5, 0xfe, 0x6f, 0x50, 0x20,                   // vmovdqu ymm2, [rax+0x20]
    0xc5, 0xf1, 0xef, 0xe2,                         // vpxor xmm4, xmm1, xmm2
    0xc5, 0xfe, 0x7f, 0xa0, 0xa0, 0x00, 0x00, 0x00  // vmovdqu [rax+0xa0], ymm4
  ];

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, sourceA);
    engine.mem_write(DATA + 0x20, sourceB);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);

    assertBytes(engine.mem_read(DATA + 0x40, 32), expected, 'VPXOR aliasing must preserve both source operands');
    assertBytes(engine.mem_read(DATA + 0x60, 32), expected, 'VPXOR 256-bit memory source must cover both 128-bit lanes');
    assertBytes(engine.mem_read(DATA + 0x80, 32), sourceA, 'VMOVDQU register form must preserve the full YMM value');
    assertBytes(
      engine.mem_read(DATA + 0xa0, 32),
      [...expected.slice(0, 16), ...new Array<number>(16).fill(0)],
      'VEX.128 destination writes must zero the upper YMM lane'
    );
  } finally {
    engine.close();
  }
}

function assertUnimplementedAvx2StillFailsClosed(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  // VPMASKMOVD is a valid AVX2 memory operation that remains outside the
  // audited subset. Keeping this rejection explicit prevents the VEX.L gate
  // from accidentally becoming a blanket AVX2 switch as cross-lane support grows.
  const unsupported = [0xc4, 0xe2, 0x75, 0x8c, 0x00]; // vpmaskmovd ymm0, ymm1, [rax]
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, unsupported);
    engine.mem_write(DATA, new Array(32).fill(0));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    assert.throws(
      () => engine.emu_start(CODE, CODE + unsupported.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      'unaudited AVX2 memory families must remain fail-closed'
    );
  } finally {
    engine.close();
  }
}

function runBmi2Shlx(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc4, 0xe2, 0x91, 0xf7, 0xd8, // shlx rbx, rax, r13
    0xc4, 0xe2, 0xb9, 0xf7, 0x02, // shlx rax, qword ptr [rdx], r8
    0xc4, 0xe2, 0x41, 0xf7, 0xc0  // shlx eax, eax, edi
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0]));
    engine.reg_write_i64(module.X86_REG_RAX, 3n);
    engine.reg_write_i64(module.X86_REG_R13, 4n);
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_R8, 5n);
    engine.reg_write_i64(module.X86_REG_RDI, 33n);
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.equal(engine.reg_read_i64(module.X86_REG_RBX), 48n, 'SHLX r64 must shift its register source by the VEX count register');
    assert.equal(engine.reg_read_i64(module.X86_REG_RAX), 192n, 'SHLX r32 must accept a memory-fed source, mask the count to 5 bits and zero-extend its result');
  } finally {
    engine.close();
  }
}

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const module = await factory();

  runSemanticClosure(module);
  assertUnimplementedAvx2StillFailsClosed(module);
  runBmi2Shlx(module);
  console.log('Unicorn AVX2 basics smoke: PASS (YMM load/store + 3-operand VPXOR + BMI2 SHLX register/memory + aliasing + VEX.128 zero-upper + fail-closed unaudited remainder)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
