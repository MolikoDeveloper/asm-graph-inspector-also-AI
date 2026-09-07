import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeUnicornModule } from '../../src/features/execution/unicornCapabilities';
import type { UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-capabilities-'));

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
  const module = await factory();
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
  const helperAdapter = probeHelperAdapter(module);
  const syscallHook = probeSyscallInsnHook(module);
  assert.equal(lowStack.supported, true, `low-address x86 stack must work: ${lowStack.error ?? ''}`);
  assert.equal(highStack.supported, true, `high-address x86 stack must work: ${highStack.error ?? ''}`);
  assert.equal(helperAdapter.supported, true, `TCG helper adapter path must work: ${helperAdapter.error ?? ''}`);
  assert.equal(syscallHook.supported, true, `UC_HOOK_INSN syscall interception must work: ${syscallHook.error ?? ''}`);

  const summary = report.probes.map((probe) => `${probe.id}=${probe.supported ? 'yes' : 'no'}`).join(' ');
  console.log(`Unicorn capability smoke: PASS · ${summary} low-stack=yes high-stack=yes helper-adapter=yes syscall-hook=yes`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
