import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UnicornFactory } from '../../src/features/execution/unicornTypes';

const PAGE_SIZE = 4096;
const HIGH_PAGE = 0x0000_7000_0205_0000n;
const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-zero-fill-'));

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const module = await factory();
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  try {
    const dirty = new Uint8Array(PAGE_SIZE);
    for (let index = 0; index < dirty.length; index += 1) dirty[index] = (index * 29 + 0x5a) & 0xff;

    engine.mem_map(HIGH_PAGE, PAGE_SIZE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(HIGH_PAGE, dirty);
    assert.deepEqual([...engine.mem_read(HIGH_PAGE, 32)], [...dirty.subarray(0, 32)], 'fixture page must contain non-zero recycled data before unmap');

    engine.mem_unmap(HIGH_PAGE, PAGE_SIZE);
    engine.mem_map(HIGH_PAGE, PAGE_SIZE, module.PROT_READ | module.PROT_WRITE);

    const remapped = engine.mem_read(HIGH_PAGE, PAGE_SIZE);
    const firstNonZero = remapped.findIndex((byte) => byte !== 0);
    assert.equal(firstNonZero, -1, `new uc_mem_map RAM must be zero-filled after allocator reuse; first non-zero byte was +0x${firstNonZero.toString(16)}`);

    console.log('Unicorn remap zero-fill smoke: PASS (dirty high page -> unmap -> fresh map -> 4096 zero bytes)');
  } finally {
    engine.close();
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
