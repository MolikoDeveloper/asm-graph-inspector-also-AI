import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx-vpmovmskb-'));
const CODE = 0x100000;
const DATA = 0x110000;
const PAGE = 4096;

function expectedMask(bytes: readonly number[]): bigint {
  let mask = 0n;
  bytes.forEach((value, index) => {
    if ((value & 0x80) !== 0) {
      mask |= 1n << BigInt(index);
    }
  });
  return mask;
}

function runRayTestYmmForm(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const source = Array.from({ length: 32 }, (_, index) => index % 3 === 0 || index === 31 ? 0x80 | index : index);
  const code = [
    0xc5, 0xfe, 0x6f, 0x00, // vmovdqu ymm0, [rax]
    0xc5, 0xfd, 0xd7, 0xf8  // vpmovmskb edi, ymm0 -- exact ray_test encoding
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RDI, 0xffff_ffff_ffff_ffffn);
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.equal(
      engine.reg_read_i64(module.X86_REG_RDI),
      expectedMask(source),
      'VPMOVMSKB ymm must concatenate low/high XMM masks and zero-extend GPR32'
    );
  } finally {
    engine.close();
  }
}

function runXmmForm(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const source = Array.from({ length: 16 }, (_, index) => index % 2 === 1 ? 0xff : 0x7f);
  const code = [
    0xc5, 0xfa, 0x6f, 0x00, // vmovdqu xmm0, [rax]
    0xc5, 0xf9, 0xd7, 0xf8  // vpmovmskb edi, xmm0
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RDI, 0xffff_ffff_ffff_ffffn);
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.equal(engine.reg_read_i64(module.X86_REG_RDI), expectedMask(source));
  } finally {
    engine.close();
  }
}

function assertReservedVvvvFails(module: UnicornModule): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  // VEX.vvvv is encoded as 1110b instead of the reserved 1111b.
  const code = [0xc4, 0xe1, 0x75, 0xd7, 0xf8];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_write(CODE, code);
    assert.throws(
      () => engine.emu_start(CODE, CODE + code.length, 0, 1),
      /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
      'VPMOVMSKB with non-reserved vvvv must remain fail-closed'
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

  runRayTestYmmForm(module);
  runXmmForm(module);
  assertReservedVvvvFails(module);

  console.log('Unicorn AVX VPMOVMSKB smoke: PASS (ray_test YMM + XMM + high-lane concatenation + GPR32 zero-extension + reserved vvvv)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
