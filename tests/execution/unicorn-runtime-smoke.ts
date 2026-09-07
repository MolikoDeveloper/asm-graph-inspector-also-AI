import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory } from '../../src/features/execution/unicornTypes';

const source = resolve('public/vendor/unicorn/unicorn_x86.js');
const bytes = readFileSync(source);
assert.ok(bytes.byteLength > 100_000, `vendored Unicorn runtime is unexpectedly small: ${bytes.byteLength} bytes`);

const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-'));
try {
  // The application is ESM, while upstream's MODULARIZE SINGLE_FILE output is
  // CommonJS-capable for Node/Bun. Copy to .cjs so the test does not depend on
  // the repository's package.json "type": "module" interpretation.
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, bytes);
  const require = createRequire(import.meta.url);
  const factory = require(runtime) as UnicornFactory;
  assert.equal(typeof factory, 'function', 'MUnicorn factory');

  const uc = await factory();
  assert.ok(uc.arch_supported(uc.ARCH_X86), 'x86 architecture must be compiled into the pinned runtime');

  const engine = new uc.Unicorn(uc.ARCH_X86, uc.MODE_64);
  try {
    const address = 0x100000;
    const code = Uint8Array.from([
      0x48, 0xc7, 0xc0, 0x2a, 0x00, 0x00, 0x00, // mov rax, 42
      0x90 // nop
    ]);
    engine.mem_map(address, 0x1000, uc.PROT_ALL);
    engine.mem_write(address, code);
    engine.emu_start(address, address + code.length, 0, 0);
    assert.equal(engine.reg_read_i64(uc.X86_REG_RAX), 42n, 'real Unicorn x86 execution result');
  } finally {
    engine.close();
  }

  console.log(`Unicorn x86 runtime smoke: PASS · ${bytes.byteLength} bytes`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
