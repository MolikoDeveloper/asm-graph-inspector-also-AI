import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeUnicornModule } from '../../src/features/execution/unicornCapabilities';
import type { UnicornFactory } from '../../src/features/execution/unicornTypes';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-capabilities-'));

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

  const summary = report.probes.map((probe) => `${probe.id}=${probe.supported ? 'yes' : 'no'}`).join(' ');
  console.log(`Unicorn capability smoke: PASS · ${summary}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
