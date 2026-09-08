import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-vpermd-'));
const CODE = 0x100000;
const DATA = 0x110000;
const MEMORY = 0x120000;
const PAGE = 4096;
const VECTOR_BYTES = 32;

function dwords(values: readonly number[]): number[] {
  assert.equal(values.length, 8);
  const output = new Array<number>(VECTOR_BYTES).fill(0);
  values.forEach((value, index) => {
    const unsigned = value >>> 0;
    for (let byte = 0; byte < 4; byte += 1) {
      output[index * 4 + byte] = (unsigned >>> (byte * 8)) & 0xff;
    }
  });
  return output;
}

function permute(indices: readonly number[], data: readonly number[]): number[] {
  assert.equal(indices.length, 8);
  assert.equal(data.length, 8);
  return indices.map((index) => data[index & 7] >>> 0);
}

function runRegisterCase(
  module: UnicornModule,
  name: string,
  modrm: number,
  indices: readonly number[],
  data: readonly number[]
): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,             // vmovdqu ymm1, [rax]
    0xc5, 0xfe, 0x6f, 0x50, 0x20,       // vmovdqu ymm2, [rax+0x20]
    0xc4, 0xe2, 0x75, 0x36, modrm,       // vpermd ymm?, ymm1, ymm2
    0xc5, 0xfe, 0x7f, 0x40, 0x40        // vmovdqu [rax+0x40], ymm0
  ];

  // For alias cases the result lives in ymm1/ymm2, so patch the final store's
  // ModRM reg field to match the VPERMD destination.
  const destination = (modrm >> 3) & 7;
  code[code.length - 2] = 0x40 | (destination << 3);

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, dwords(indices));
    engine.mem_write(DATA + 0x20, dwords(data));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      dwords(permute(indices, data)),
      `${name} must select across the full eight-dword YMM domain`
    );
  } finally {
    engine.close();
  }
}

function runMemoryBoundaryCase(
  module: UnicornModule,
  indices: readonly number[],
  data: readonly number[]
): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const source = MEMORY + PAGE - VECTOR_BYTES;
  const code = [
    0xc5, 0xfe, 0x6f, 0x0b,             // vmovdqu ymm1, [rbx]
    0xc4, 0xe2, 0x75, 0x36, 0x00,       // vpermd ymm0, ymm1, [rax]
    0xc5, 0xfe, 0x7f, 0x43, 0x20        // vmovdqu [rbx+0x20], ymm0
  ];

  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(MEMORY, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, dwords(indices));
    engine.mem_write(source, dwords(data));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(DATA));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(source));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x20, VECTOR_BYTES)],
      dwords(permute(indices, data)),
      'VPERMD m256 must read exactly 32 bytes and preserve cross-lane selection'
    );
  } finally {
    engine.close();
  }
}

function assertReservedFormsFailClosed(module: UnicornModule): void {
  const forms = [
    { name: 'VEX.L=0', bytes: [0xc4, 0xe2, 0x71, 0x36, 0xc2] },
    { name: 'VEX.W=1', bytes: [0xc4, 0xe2, 0xf5, 0x36, 0xc2] }
  ] as const;

  for (const form of forms) {
    const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
    try {
      engine.mem_map(CODE, PAGE, module.PROT_ALL);
      engine.mem_write(CODE, form.bytes);
      assert.throws(
        () => engine.emu_start(CODE, CODE + form.bytes.length, 0, 1),
        /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
        `VPERMD ${form.name} must remain fail-closed`
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

  const data = [
    0x11111111, 0x22222222, 0x33333333, 0x44444444,
    0xaaaaaaaa, 0xbbbbbbbb, 0xcccccccc, 0xdddddddd
  ];
  // Every half selects from the opposite 128-bit lane. High index bits prove
  // the selector is masked to three bits rather than range-checked or lane-local.
  const indices = [0x80000007, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11, 0x10];

  runRegisterCase(module, 'ordinary registers', 0xc2, indices, data); // dest=ymm0
  runRegisterCase(module, 'dest aliases index vector', 0xca, indices, data); // dest=ymm1
  runRegisterCase(module, 'dest aliases data vector', 0xd2, indices, data); // dest=ymm2
  runMemoryBoundaryCase(module, indices, data);
  assertReservedFormsFailClosed(module);

  console.log(
    'Unicorn AVX2 VPERMD smoke: PASS (full-YMM cross-lane selection + aliasing + exact m256 + reserved forms)'
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
