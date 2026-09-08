import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-avx2-broadcast-'));
const CODE = 0x100000;
const DATA = 0x110000;
const OUT = 0x120000;
const PAGE = 4096;
const VECTOR_BYTES = 32;

type BroadcastOperation = Readonly<{
  name: string;
  opcode: 0x58 | 0x59 | 0x78 | 0x79;
  widthBytes: 1 | 2 | 4 | 8;
  scalar: bigint;
}>;

const OPERATIONS: readonly BroadcastOperation[] = [
  { name: 'VPBROADCASTB', opcode: 0x78, widthBytes: 1, scalar: 0xa5n },
  { name: 'VPBROADCASTW', opcode: 0x79, widthBytes: 2, scalar: 0xbeefn },
  { name: 'VPBROADCASTD', opcode: 0x58, widthBytes: 4, scalar: 0x89abcdefn },
  { name: 'VPBROADCASTQ', opcode: 0x59, widthBytes: 8, scalar: 0x0123456789abcdefn }
];

function scalarBytes(operation: BroadcastOperation): number[] {
  return Array.from({ length: operation.widthBytes }, (_, index) =>
    Number((operation.scalar >> BigInt(index * 8)) & 0xffn));
}

function expected(operation: BroadcastOperation, outputBytes = VECTOR_BYTES): number[] {
  const scalar = scalarBytes(operation);
  return Array.from({ length: outputBytes }, (_, index) => scalar[index % scalar.length]);
}

function sourceVector(operation: BroadcastOperation): number[] {
  const bytes = Array.from({ length: VECTOR_BYTES }, (_, index) => (0x31 + index * 17) & 0xff);
  bytes.splice(0, operation.widthBytes, ...scalarBytes(operation));
  return bytes;
}

function vexMap38(
  operation: BroadcastOperation,
  dest: number,
  rm: number,
  width: 128 | 256 = 256,
  options: { w?: 0 | 1; encodedVvvv?: number } = {}
): number[] {
  const encodedVvvv = options.encodedVvvv ?? 0x0f; // reserved vvvv=1111b on the wire
  const third = ((options.w ?? 0) << 7) | ((encodedVvvv & 0x0f) << 3) |
    (width === 256 ? 0x04 : 0) | 0x01;
  const modrm = 0xc0 | ((dest & 7) << 3) | (rm & 7);
  return [0xc4, 0xe2, third, operation.opcode, modrm];
}

function storeYmmFromRax(reg: number, displacement: number): number[] {
  return [0xc5, 0xfe, 0x7f, 0x40 | ((reg & 7) << 3), displacement & 0xff];
}

function runRegisterCase(module: UnicornModule, operation: BroadcastOperation, dest: 1 | 2): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const source = sourceVector(operation);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08, // vmovdqu ymm1, [rax]
    ...vexMap38(operation, dest, 1),
    ...storeYmmFromRax(dest, 0x40)
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
      expected(operation),
      `${operation.name} register source failed${dest === 1 ? ' when destination aliases source' : ''}`
    );
  } finally {
    engine.close();
  }
}

function runExactMemoryWidth(module: UnicornModule, operation: BroadcastOperation): void {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const sourceAddress = DATA + PAGE - operation.widthBytes;
  const third = 0x7d; // W=0, reserved vvvv, L=1, pp=66
  const modrm = 0x13; // mod=00, dest=ymm2, r/m=[rbx]
  const code = [
    0xc4, 0xe2, third, operation.opcode, modrm,
    0xc5, 0xfe, 0x7f, 0x10 // vmovdqu [rax], ymm2
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_map(OUT, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(sourceAddress, scalarBytes(operation));
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(OUT));
    engine.reg_write_i64(module.X86_REG_RBX, BigInt(sourceAddress));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(OUT, VECTOR_BYTES)],
      expected(operation),
      `${operation.name} memory form must read exactly ${operation.widthBytes} byte(s)`
    );
  } finally {
    engine.close();
  }
}

function runVex128ZeroUpper(module: UnicornModule): void {
  const operation = OPERATIONS.find((item) => item.name === 'VPBROADCASTD')!;
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const source = sourceVector(operation);
  const seed = new Array<number>(VECTOR_BYTES).fill(0xa7);
  const code = [
    0xc5, 0xfe, 0x6f, 0x08,       // vmovdqu ymm1, [rax]
    0xc5, 0xfe, 0x6f, 0x50, 0x20, // seed ymm2
    ...vexMap38(operation, 2, 1, 128),
    ...storeYmmFromRax(2, 0x40)
  ];
  try {
    engine.mem_map(CODE, PAGE, module.PROT_ALL);
    engine.mem_map(DATA, PAGE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(CODE, code);
    engine.mem_write(DATA, source);
    engine.mem_write(DATA + 0x20, seed);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(DATA));
    engine.emu_start(CODE, CODE + code.length, 0, 0);
    assert.deepEqual(
      [...engine.mem_read(DATA + 0x40, VECTOR_BYTES)],
      [...expected(operation, 16), ...new Array<number>(16).fill(0)],
      'VEX.128 VPBROADCASTD must zero the upper YMM lane'
    );
  } finally {
    engine.close();
  }
}

function assertReservedEncodingsFail(module: UnicornModule): void {
  const operation = OPERATIONS[2];
  for (const [label, instruction] of [
    ['non-reserved vvvv', vexMap38(operation, 2, 1, 256, { encodedVvvv: 0x0e })],
    ['VEX.W=1', vexMap38(operation, 2, 1, 256, { w: 1 })]
  ] as const) {
    const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
    try {
      engine.mem_map(CODE, PAGE, module.PROT_ALL);
      engine.mem_write(CODE, instruction);
      assert.throws(
        () => engine.emu_start(CODE, CODE + instruction.length, 0, 1),
        /Invalid instruction|UC_ERR_INSN_INVALID|invalid/i,
        `VPBROADCAST reserved ${label} encoding must remain fail-closed`
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

  for (const operation of OPERATIONS) {
    runRegisterCase(module, operation, 2);
    runRegisterCase(module, operation, 1);
    runExactMemoryWidth(module, operation);
  }
  runVex128ZeroUpper(module);
  assertReservedEncodingsFail(module);

  console.log(
    `Unicorn AVX2 broadcast smoke: PASS (${OPERATIONS.length} integer broadcasts + register aliasing + exact-width memory + VEX.128 zero-upper + reserved encoding rejection)`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
