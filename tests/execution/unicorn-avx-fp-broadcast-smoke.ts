import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx-fp-broadcast-'));
const CODE = 0x100000;
const DATA = 0x110000;
const OUT = 0x120000;
const PAGE = 4096;

function assertBytes(actual: Uint8Array, expected: readonly number[], label: string): void {
  assert.deepEqual([...actual], [...expected], label);
}

function repeated(source: readonly number[], totalBytes: number): number[] {
  return Array.from({ length: totalBytes }, (_, index) => source[index % source.length]);
}

function vexBroadcast(opcode: 0x18 | 0x19 | 0x1a, dest: number, base: number, width: 128 | 256, encodedVvvv = 0x0f): number[] {
  const third = ((encodedVvvv & 0x0f) << 3) | (width === 256 ? 0x04 : 0) | 0x01;
  const modrm = ((dest & 7) << 3) | (base & 7);
  return [0xc4, 0xe2, third, opcode, modrm];
}

function runBroadcastSsXmm(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const scalar = [0x12, 0x34, 0x56, 0x78];
  const seed = new Array<number>(32).fill(0xa5);
  const source = DATA + PAGE - scalar.length;
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,       // vmovdqu ymm1, [rax] -- seed upper lane
    0xc4, 0xe2, 0x79, 0x18, 0x0b, // vbroadcastss xmm1, dword [rbx]
    0xc5, 0xfe, 0x7f, 0x0a        // vmovdqu [rdx], ymm1
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, seed);
    engine.mem_write(source, scalar);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(source));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assertBytes(
      engine.mem_read(OUT, 32),
      [...repeated(scalar, 16), ...new Array<number>(16).fill(0)],
      'VBROADCASTSS xmm must duplicate the exact m32 source and zero upper YMM'
    );
  } finally {
    engine.close();
  }
}

function runBroadcastSsYmm(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const scalar = [0xde, 0xad, 0xbe, 0xef];
  const source = DATA + PAGE - scalar.length;
  const code = [
    0xc4, 0xe2, 0x7d, 0x18, 0x03, // vbroadcastss ymm0, dword [rbx]
    0xc5, 0xfe, 0x7f, 0x00        // vmovdqu [rax], ymm0
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(source, scalar);
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(source));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assertBytes(engine.mem_read(OUT, 32), repeated(scalar, 32), 'VBROADCASTSS ymm must broadcast m32 across all eight dwords');
  } finally {
    engine.close();
  }
}

function runBroadcastSdYmm(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const scalar = [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01];
  const source = DATA + PAGE - scalar.length;
  const code = [
    0xc4, 0xe2, 0x7d, 0x19, 0x03, // vbroadcastsd ymm0, qword [rbx]
    0xc5, 0xfe, 0x7f, 0x00        // vmovdqu [rax], ymm0
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(source, scalar);
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(source));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assertBytes(engine.mem_read(OUT, 32), repeated(scalar, 32), 'VBROADCASTSD ymm must broadcast the exact m64 source across four qwords');
  } finally {
    engine.close();
  }
}

function runBroadcastF128(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const lane = Array.from({ length: 16 }, (_, index) => (0x41 + index * 11) & 0xff);
  const source = DATA + PAGE - lane.length;
  const code = [
    0xc4, 0xe2, 0x7d, 0x1a, 0x03, // vbroadcastf128 ymm0, oword [rbx]
    0xc5, 0xfe, 0x7f, 0x00        // vmovdqu [rax], ymm0
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(source, lane);
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(source));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assertBytes(engine.mem_read(OUT, 32), [...lane, ...lane], 'VBROADCASTF128 must duplicate one exact m128 lane');
  } finally {
    engine.close();
  }
}

function assertReservedFormsFail(module: UnicornModule): void {
  const invalidForms: readonly [string, number[]][] = [
    ['VBROADCASTSS non-reserved vvvv', vexBroadcast(0x18, 0, 0, 256, 0x0e)],
    ['VBROADCASTSS register source', [0xc4, 0xe2, 0x7d, 0x18, 0xc1]],
    ['VBROADCASTSD VEX.128', vexBroadcast(0x19, 0, 0, 128)],
    ['VBROADCASTF128 VEX.128', vexBroadcast(0x1a, 0, 0, 128)]
  ];

  for (const [label, code] of invalidForms) {
    const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
    try {
      engine.mem_map(CODE, PAGE, module.PROT_ALL);
      engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
      engine.mem_write(CODE, code);
      engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
      assert.throws(
        () => engine.emu_start(CODE, CODE + code.length, 0, 1),
        /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
        `${label} must remain fail-closed`
      );
    } finally {
      engine.close();
    }
  }
}

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const module = await factory();

  runBroadcastSsXmm(module);
  runBroadcastSsYmm(module);
  runBroadcastSdYmm(module);
  runBroadcastF128(module);
  assertReservedFormsFail(module);

  console.log('Unicorn AVX FP broadcast smoke: PASS (VBROADCASTSS XMM/YMM + VBROADCASTSD + VBROADCASTF128 + exact source widths + zero-upper + reserved forms)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
