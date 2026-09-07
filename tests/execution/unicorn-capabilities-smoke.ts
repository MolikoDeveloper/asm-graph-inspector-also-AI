import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createX86_64InstructionDecoder } from '../../src/features/capstone/capstoneDecoder';
import type { CapstoneModule } from '../../src/features/capstone/types';
import { probeUnicornModule } from '../../src/features/execution/unicornCapabilities';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-capabilities-'));

type HighRipHookMode = 'none' | 'empty' | 'mem-read' | 'capstone';

function probeStackWrite(module: UnicornModule, stackTop: number): { supported: boolean; error: string | null } {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = 0x200000;
  const page = 4096;
  try {
    engine.mem_map(code, page, module.PROT_ALL);
    engine.mem_write(code, [0x55]); // push rbp
    engine.mem_map(stackTop - page, page, module.PROT_READ | module.PROT_WRITE);
    engine.reg_write_i64(module.X86_REG_RSP, BigInt(stackTop));
    engine.reg_write_i64(module.X86_REG_RBP, 0x1122334455667788n);
    engine.emu_start(code, code + 1, 0, 1);
    const rsp = engine.reg_read_i64(module.X86_REG_RSP);
    assert.equal(rsp, BigInt(stackTop - 8), `push must decrement RSP at 0x${stackTop.toString(16)}`);
    const stored = engine.mem_read(stackTop - 8, 8);
    assert.deepEqual([...stored], [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]);
    return { supported: true, error: null };
  } catch (cause) {
    let detail = cause instanceof Error ? cause.message : String(cause);
    try { detail += ` (errno ${engine.errno()}: ${module.strerror(engine.errno())})`; } catch { /* observed exception is sufficient */ }
    return { supported: false, error: detail };
  } finally {
    engine.close();
  }
}

function probeHighRipLoaderPrologue(
  module: UnicornModule,
  hookMode: HighRipHookMode = 'none',
  capstone: CapstoneModule | null = null,
  emulationCount = 0
): { supported: boolean; error: string | null } {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const decoder = hookMode === 'capstone' && capstone ? createX86_64InstructionDecoder(capstone) : null;
  const code = 0x0000_7f00_0001_8ef0;
  const page = 4096;
  const alignPage = (address: number) => Math.floor(address / page) * page;
  // Never use JS bitwise alignment for 64-bit guest addresses: bitwise operators
  // coerce to signed 32-bit and silently map an unrelated low page.
  const codePage = alignPage(code);
  const dataPage = 0x0000_7f00_0003_7000;
  const dataAddress = 0x0000_7f00_0003_7b2c;
  const stackTop = 0x0000_7fff_ffff_ed60;
  const stackPage = alignPage(stackTop);
  const prologue = [
    0x55,                         // push rbp
    0x48, 0x89, 0xe5,             // mov rsp, rbp
    0x41, 0x57,                   // push r15
    0x41, 0x56,                   // push r14
    0x41, 0x55,                   // push r13
    0x41, 0x54,                   // push r12
    0x53,                         // push rbx
    0x48, 0x81, 0xec, 0xb0, 0x00, 0x00, 0x00, // sub rsp, 0xb0
    0x8b, 0x3d, 0x22, 0xec, 0x01, 0x00        // mov edi, [rip+0x1ec22] -> 0x7f0000037b2c
  ];
  let hook = null as ReturnType<typeof engine.hook_add> | null;
  let hookHits = 0;
  let hookReadBytes = 0;
  let decodedHits = 0;
  try {
    if (hookMode === 'capstone' && !decoder) throw new Error('Capstone module is required for the code-hook decode probe.');
    engine.mem_map(codePage, page, module.PROT_ALL);
    engine.mem_write(code, prologue);
    assert.deepEqual([...engine.mem_read(code, prologue.length)], prologue, 'high-RIP code bytes must round-trip after mapping');
    engine.mem_map(dataPage, page, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(dataAddress, [0x08, 0x00, 0x00, 0x80]);
    engine.mem_map(stackPage, page, module.PROT_READ | module.PROT_WRITE);
    engine.reg_write_i64(module.X86_REG_RSP, BigInt(stackTop));
    engine.reg_write_i64(module.X86_REG_RBP, BigInt(stackTop));
    engine.reg_write_i64(module.X86_REG_R15, 0x1111n);
    engine.reg_write_i64(module.X86_REG_R14, 0x2222n);
    engine.reg_write_i64(module.X86_REG_R13, 0x3333n);
    engine.reg_write_i64(module.X86_REG_R12, 0x4444n);
    engine.reg_write_i64(module.X86_REG_RBX, 0x5555n);
    if (hookMode !== 'none') {
      hook = engine.hook_add(module.HOOK_CODE, (...args: unknown[]) => {
        hookHits += 1;
        if (hookMode === 'mem-read' || hookMode === 'capstone') {
          const addressValue = args[1];
          const sizeValue = args[2];
          const address = typeof addressValue === 'bigint' ? addressValue : BigInt(Number(addressValue));
          const size = Math.max(1, Number(sizeValue));
          const bytes = engine.mem_read(address, size);
          hookReadBytes += bytes.length;
          if (hookMode === 'capstone') {
            const numericAddress = Number(address);
            assert.ok(Number.isSafeInteger(numericAddress), 'high-RIP hook address must remain a safe JS integer');
            const decoded = decoder!.decodeOne(bytes, numericAddress);
            assert.ok(decoded, `Capstone must decode UC_HOOK_CODE bytes at 0x${address.toString(16)}`);
            assert.equal(decoded.address, numericAddress);
            decodedHits += 1;
          }
        }
      });
    }
    engine.emu_start(code, code + prologue.length, 0, emulationCount);
    assert.equal(engine.reg_read_i64(module.X86_REG_RDI), 0x80000008n, 'high-RIP RIP-relative load must preserve the 32-bit feature word');
    assert.equal(engine.reg_read_i64(module.X86_REG_RSP), BigInt(stackTop - 5 * 8 - 0xb0 - 8), 'loader prologue stack shape must match x86-64 pushes');
    if (hookMode !== 'none') assert.ok(hookHits > 0, 'UC_HOOK_CODE must observe the high-RIP loader prologue');
    if (hookMode === 'mem-read' || hookMode === 'capstone') assert.ok(hookReadBytes >= hookHits, 'UC_HOOK_CODE reentrant mem_read must return instruction bytes for every callback');
    if (hookMode === 'capstone') assert.equal(decodedHits, hookHits, 'Capstone must decode every high-RIP UC_HOOK_CODE callback');
    return { supported: true, error: null };
  } catch (cause) {
    let detail = cause instanceof Error ? cause.message : String(cause);
    try { detail += ` (errno ${engine.errno()}: ${module.strerror(engine.errno())})`; } catch { /* observed exception is sufficient */ }
    return { supported: false, error: detail };
  } finally {
    if (hook) {
      try { engine.hook_del(hook); } catch { /* engine may already be terminal */ }
    }
    decoder?.close();
    engine.close();
  }
}

function probeHelperAdapter(module: UnicornModule): { supported: boolean; error: string | null } {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = 0x300000;
  const page = 4096;
  const div64 = [
    0x48, 0x31, 0xd2,                         // xor rdx, rdx
    0x48, 0xc7, 0xc0, 0xe8, 0x03, 0x00, 0x00, // mov rax, 1000
    0x48, 0xc7, 0xc1, 0x07, 0x00, 0x00, 0x00, // mov rcx, 7
    0x48, 0xf7, 0xf1                          // div rcx -> TCG helper path
  ];
  try {
    engine.mem_map(code, page, module.PROT_ALL);
    engine.mem_write(code, div64);
    engine.emu_start(code, code + div64.length, 0, 0);
    assert.equal(engine.reg_read_i64(module.X86_REG_RAX), 142n);
    assert.equal(engine.reg_read_i64(module.X86_REG_RDX), 6n);
    return { supported: true, error: null };
  } catch (cause) {
    let detail = cause instanceof Error ? cause.message : String(cause);
    try { detail += ` (errno ${engine.errno()}: ${module.strerror(engine.errno())})`; } catch { /* observed exception is sufficient */ }
    return { supported: false, error: detail };
  } finally {
    engine.close();
  }
}

function probeSyscallInsnHook(module: UnicornModule): { supported: boolean; error: string | null } {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const code = 0x400000;
  const page = 4096;
  let hook = null as ReturnType<typeof engine.hook_add> | null;
  let hits = 0;
  try {
    engine.mem_map(code, page, module.PROT_ALL);
    engine.mem_write(code, [0x0f, 0x05]); // syscall
    hook = engine.hook_add(module.HOOK_INSN, () => {
      hits += 1;
      engine.emu_stop();
    }, {}, code, code + 2, module.X86_INS_SYSCALL);
    try { engine.emu_start(code, code + 2, 0, 1); } catch { /* hook firing is authoritative */ }
    assert.equal(hits, 1, 'UC_HOOK_INSN must intercept SYSCALL exactly once');
    return { supported: true, error: null };
  } catch (cause) {
    let detail = cause instanceof Error ? cause.message : String(cause);
    try { detail += ` (errno ${engine.errno()}: ${module.strerror(engine.errno())})`; } catch { /* observed exception is sufficient */ }
    return { supported: false, error: detail };
  } finally {
    if (hook) {
      try { engine.hook_del(hook); } catch { /* engine may already be terminal */ }
    }
    engine.close();
  }
}

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const [module, capstone] = await Promise.all([factory(), loadHeadlessCapstone()]);
  const report = probeUnicornModule(module);

  assert.equal(report.architecture, 'x86-64');
  assert.equal(report.evidence, 'observed-unicorn-execution');
  assert.deepEqual(report.probes.map((probe) => probe.id), ['baseline', 'cpuid', 'xgetbv', 'sse2', 'avx', 'avx2']);
  assert.equal(report.probes.find((probe) => probe.id === 'baseline')?.supported, true, 'baseline must execute');
  assert.equal(report.probes.find((probe) => probe.id === 'sse2')?.supported, true, 'SSE2 must execute');

  for (const probe of report.probes) {
    assert.equal(typeof probe.supported, 'boolean');
    if (!probe.supported) assert.ok(probe.error, `${probe.label} rejection must retain observed error evidence`);
  }

  const lowStack = probeStackWrite(module, 0x7ff00000);
  const highStack = probeStackWrite(module, 0x0000_7fff_ffff_f000);
  const highRipLoader = probeHighRipLoaderPrologue(module);
  const highRipCounted = probeHighRipLoaderPrologue(module, 'none', null, 500);
  const highRipCodeHook = probeHighRipLoaderPrologue(module, 'empty');
  const highRipCountedCodeHook = probeHighRipLoaderPrologue(module, 'empty', null, 500);
  const highRipCodeHookRead = probeHighRipLoaderPrologue(module, 'mem-read');
  const highRipCodeHookCapstone = probeHighRipLoaderPrologue(module, 'capstone', capstone);
  const helperAdapter = probeHelperAdapter(module);
  const syscallHook = probeSyscallInsnHook(module);
  assert.equal(lowStack.supported, true, `low-address x86 stack must work: ${lowStack.error ?? ''}`);
  assert.equal(highStack.supported, true, `high-address x86 stack must work: ${highStack.error ?? ''}`);
  assert.equal(highRipLoader.supported, true, `high-RIP loader prologue must work: ${highRipLoader.error ?? ''}`);
  assert.equal(highRipCounted.supported, true, `high-RIP loader prologue with Unicorn instruction count must work: ${highRipCounted.error ?? ''}`);
  assert.equal(highRipCodeHook.supported, true, `high-RIP loader prologue with empty UC_HOOK_CODE must work: ${highRipCodeHook.error ?? ''}`);
  assert.equal(highRipCountedCodeHook.supported, true, `high-RIP loader prologue with instruction count + UC_HOOK_CODE must work: ${highRipCountedCodeHook.error ?? ''}`);
  assert.equal(highRipCodeHookRead.supported, true, `high-RIP loader UC_HOOK_CODE mem_read must work: ${highRipCodeHookRead.error ?? ''}`);
  assert.equal(highRipCodeHookCapstone.supported, true, `high-RIP loader UC_HOOK_CODE Capstone decode must work: ${highRipCodeHookCapstone.error ?? ''}`);
  assert.equal(helperAdapter.supported, true, `TCG helper adapter path must work: ${helperAdapter.error ?? ''}`);
  assert.equal(syscallHook.supported, true, `UC_HOOK_INSN syscall interception must work: ${syscallHook.error ?? ''}`);

  const summary = report.probes.map((probe) => `${probe.id}=${probe.supported ? 'yes' : 'no'}`).join(' ');
  console.log(`Unicorn capability smoke: PASS · ${summary} low-stack=yes high-stack=yes high-rip-loader=yes high-rip-counted=yes high-rip-code-hook=yes high-rip-counted-code-hook=yes high-rip-code-hook-read=yes high-rip-code-hook-capstone=yes helper-adapter=yes syscall-hook=yes`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
