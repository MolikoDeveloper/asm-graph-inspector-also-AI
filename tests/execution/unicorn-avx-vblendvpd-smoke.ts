import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx-vblendvpd-'));
const CODE = 0x100000;
const DATA = 0x110000;
const OUT = 0x120000;
const SOURCE_PAGE = 0x130000;
const AUX = 0x150000;
const PAGE = 4096;
const SIGN = 0x8000_0000_0000_0000n;

function qwords(values: bigint[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setBigUint64(index * 8, BigInt.asUintN(64, value), true));
  return bytes;
}

function readQwords(bytes: Uint8Array): bigint[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: bigint[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 8) values.push(view.getBigUint64(offset, true));
  return values;
}

function runRayEncodingAndZeroUpper(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const src2 = [0xaaaa_aaaa_aaaa_aaa1n, 0xbbbb_bbbb_bbbb_bbb2n];
  const mask = [1n, SIGN]; // non-zero is insufficient: only the sign bit selects src2.
  const src1 = [0x1111_1111_1111_1111n, 0x2222_2222_2222_2222n];
  const dirtyUpper = [0xdead_beef_dead_beefn, 0xcafe_babe_cafe_baben];
  const code = [
    0xc5, 0xfe, 0x6f, 0x00,             // vmovdqu ymm0, [rax]
    0xc5, 0xfa, 0x6f, 0x48, 0x20,       // vmovdqu xmm1, [rax+0x20]
    0xc5, 0xfa, 0x6f, 0x50, 0x30,       // vmovdqu xmm2, [rax+0x30]
    0xc4, 0xe3, 0x69, 0x4b, 0xc0, 0x10, // ray_test: vblendvpd xmm0,xmm2,xmm0,xmm1
    0xc5, 0xfe, 0x7f, 0x02              // vmovdqu [rdx], ymm0
  ];

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, qwords([...src2, ...dirtyUpper]));
    engine.mem_write(DATA + 0x20, qwords(mask));
    engine.mem_write(DATA + 0x30, qwords(src1));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);

    assert.deepEqual(
      readQwords(engine.mem_read(OUT, 32)),
      [src1[0], src2[1], 0n, 0n],
      'ray_test VBLENDVPD must use mask sign bits, preserve dest==src2 aliasing, and zero upper YMM state'
    );
  } finally {
    engine.close();
  }
}

function runYmm(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const src2 = [0x10n, 0x20n, 0x30n, 0x40n];
  const mask = [0n, SIGN, SIGN | 7n, 0x7fff_ffff_ffff_ffffn];
  const src1 = [0x101n, 0x202n, 0x303n, 0x404n];
  const code = [
    0xc5, 0xfe, 0x6f, 0x00,             // vmovdqu ymm0, [rax]
    0xc5, 0xfe, 0x6f, 0x48, 0x20,       // vmovdqu ymm1, [rax+0x20]
    0xc5, 0xfe, 0x6f, 0x50, 0x40,       // vmovdqu ymm2, [rax+0x40]
    0xc4, 0xe3, 0x6d, 0x4b, 0xc0, 0x10, // vblendvpd ymm0,ymm2,ymm0,ymm1
    0xc5, 0xfe, 0x7f, 0x02              // vmovdqu [rdx], ymm0
  ];

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, qwords(src2));
    engine.mem_write(DATA + 0x20, qwords(mask));
    engine.mem_write(DATA + 0x40, qwords(src1));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);

    assert.deepEqual(
      readQwords(engine.mem_read(OUT, 32)),
      [src1[0], src2[1], src2[2], src1[3]],
      'VBLENDVPD ymm must select all four qwords from the explicit mask register'
    );
  } finally {
    engine.close();
  }
}

function runExactWidthMemory(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const source = SOURCE_PAGE + PAGE - 16;
  const src2 = [0xaaaa_n, 0xbbbb_n];
  const src1 = [0x1111_n, 0x2222_n];
  const mask = [SIGN, 0n];
  const code = [
    0xc5, 0xfa, 0x6f, 0x23,             // vmovdqu xmm4, [rbx]
    0xc5, 0xfa, 0x6f, 0x6b, 0x10,       // vmovdqu xmm5, [rbx+0x10]
    0xc4, 0xe3, 0x59, 0x4b, 0x18, 0x50, // vblendvpd xmm3,xmm4,[rax],xmm5
    0xc5, 0xfa, 0x7f, 0x1a              // vmovdqu [rdx], xmm3
  ];

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(SOURCE_PAGE, PAGE, module.PROT_READ | module.PROT_WRITE);
    // SOURCE_PAGE + PAGE intentionally remains the start of an unmapped page.
    engine.mem_map(AUX, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(source, qwords(src2));
    engine.mem_write(AUX, qwords(src1));
    engine.mem_write(AUX + 0x10, qwords(mask));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(source));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(AUX));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);

    assert.deepEqual(
      readQwords(engine.mem_read(OUT, 16)),
      [src2[0], src1[1]],
      'VBLENDVPD xmm memory form must read exactly m128 and not cross the page boundary'
    );
  } finally {
    engine.close();
  }
}

function runMaskDestinationAlias(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const mask = [SIGN, 0n];
  const src1 = [0x1111n, 0x2222n];
  const src2 = [0xaaaaan, 0xbbbbn];
  const code = [
    0xc5, 0xfa, 0x6f, 0x00,             // vmovdqu xmm0, [rax]
    0xc5, 0xfa, 0x6f, 0x50, 0x10,       // vmovdqu xmm2, [rax+0x10]
    0xc5, 0xfa, 0x6f, 0x58, 0x20,       // vmovdqu xmm3, [rax+0x20]
    0xc4, 0xe3, 0x69, 0x4b, 0xc3, 0x00, // vblendvpd xmm0,xmm2,xmm3,xmm0
    0xc5, 0xfa, 0x7f, 0x02              // vmovdqu [rdx], xmm0
  ];

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, qwords(mask));
    engine.mem_write(DATA + 0x10, qwords(src1));
    engine.mem_write(DATA + 0x20, qwords(src2));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RDX, BigInt(OUT));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(readQwords(engine.mem_read(OUT, 16)), [src2[0], src1[1]], 'VBLENDVPD must tolerate mask==dest aliasing');
  } finally {
    engine.close();
  }
}

function assertRejected(module: UnicornModule, code: number[], message: string): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, code);
    assert.throws(
      () => engine.emu_start(CODE, CODE + code.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      message
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

  runRayEncodingAndZeroUpper(module);
  runYmm(module);
  runExactWidthMemory(module);
  runMaskDestinationAlias(module);
  assertRejected(module, [0xc4, 0xe3, 0xe9, 0x4b, 0xc0, 0x10], 'VBLENDVPD with VEX.W=1 must remain invalid');
  assertRejected(module, [0xc4, 0xe3, 0x69, 0x4a, 0xc0, 0x10], 'Unaudited VBLENDVPS must remain fail-closed');

  console.log('Unicorn AVX VBLENDVPD smoke: PASS (ray_test encoding + XMM/YMM + explicit mask + aliases + exact m128 + zero-upper + fail-closed 0F3A remainder)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
