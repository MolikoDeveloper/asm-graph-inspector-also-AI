import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseElfImage } from '../../src/features/binary/elfParser';
import type { ProjectFile } from '../../src/features/project/model';
import { UnicornMachineSession } from '../../src/features/execution/unicornMachineSession';
import type { UnicornFactory } from '../../src/features/execution/unicornTypes';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';
import { makeMinimalStaticElf } from './headless-fixtures';

const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-session-'));

try {
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const [unicorn, capstone] = await Promise.all([factory(), loadHeadlessCapstone()]);

  const bytes = makeMinimalStaticElf();
  const file: ProjectFile = {
    id: 'unicorn-static-fixture',
    path: 'build/unicorn-static-fixture',
    name: 'unicorn-static-fixture',
    kind: 'binary',
    language: 'binary',
    bytes,
    size: bytes.byteLength,
    updatedAt: 1
  };
  const image = parseElfImage(file.id, file.path, bytes);
  const session = UnicornMachineSession.createWithModules(file, image, unicorn, capstone);

  try {
    assert.equal(session.snapshot().provider, 'unicorn-machine');
    assert.equal(session.snapshot().status, 'ready');

    const first = session.step();
    assert.equal(first.status, 'paused');
    assert.equal(first.instructionCount, 1);
    assert.equal(first.lastInstruction?.mnemonic, 'xor');

    const second = session.step();
    assert.equal(second.status, 'paused');
    assert.equal(second.instructionCount, 2);
    assert.equal(second.lastInstruction?.mnemonic, 'mov');

    const third = session.step();
    assert.equal(third.status, 'exited');
    assert.equal(third.provider, 'unicorn-machine');
    assert.equal(third.exitCode, 0);
    assert.equal(third.instructionCount, 3);
    assert.equal(third.lastInstruction?.mnemonic, 'syscall');
    assert.equal(third.registers?.rip, BigInt(image.entry + 9), 'virtual Linux syscall must advance RIP past syscall');
    assert.ok(third.events.some((event) => event.kind === 'syscall' && event.name === 'exit'));
    assert.ok(third.events.some((event) => event.kind === 'exit' && event.code === 0));
  } finally {
    session.dispose();
  }

  console.log('Unicorn machine session smoke: PASS (real Unicorn + real Capstone + static ELF)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
