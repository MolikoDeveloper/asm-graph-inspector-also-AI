import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeUnicornModule } from '../../src/features/execution/unicornCapabilities';
import type { UnicornFactory } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-capability-scope-'));

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const module = await factory();
  const report = probeUnicornModule(module);

  assert.equal(report.scope, 'observed-probes');
  assert.equal(report.completeIsaLevel, null);

  const avx2 = report.probes.find((probe) => probe.id === 'avx2');
  assert.ok(avx2, 'AVX2 subset probe must remain present');
  assert.equal(avx2.supported, true, `AVX2 audited subset must execute: ${avx2.error ?? ''}`);
  assert.match(avx2.label, /audited-subset/i);
  assert.match(avx2.label, /not a full ISA claim/i);

  console.log('Unicorn capability scope smoke: PASS (observed probes only; no complete ISA level claimed)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
