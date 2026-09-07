import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectElfHeader } from '../../src/features/binary/elfParser';
import { runElfHeadless } from '../../src/features/execution/headless/runner';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';
import {
  PINNED_NASM_LD_ASSETS,
  verifyPinnedToolAsset
} from '../../src/features/toolchain/pinnedNasmLdToolchain';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runTool(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed with ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const nasmPath = resolve(root, 'public/vendor/toolchain/nasm.3.00.elf');
const ldPath = resolve(root, 'public/vendor/toolchain/gnu-ld.2.43.50.elf');
const sourcePath = resolve(root, 'tests/toolchain/fixtures/hello-world.asm');

const nasmBytes = new Uint8Array(await readFile(nasmPath));
const ldBytes = new Uint8Array(await readFile(ldPath));
await verifyPinnedToolAsset(PINNED_NASM_LD_ASSETS[0], nasmBytes);
await verifyPinnedToolAsset(PINNED_NASM_LD_ASSETS[1], ldBytes);

const work = await mkdtemp(resolve(tmpdir(), 'asm-graph-real-toolchain-'));
try {
  const objectPath = resolve(work, 'hello.o');
  const executablePath = resolve(work, 'hello');

  runTool(nasmPath, ['-f', 'elf64', sourcePath, '-o', objectPath]);
  const objectBuffer = exactArrayBuffer(new Uint8Array(await readFile(objectPath)));
  const objectHeader = inspectElfHeader(objectBuffer);
  assert(objectHeader.valid, 'NASM output must be a valid ELF');
  assert(objectHeader.architecture === 'x86-64', `NASM object must be x86-64, got ${objectHeader.architecture}`);
  assert(objectHeader.kind === 'relocatable', `NASM must produce ET_REL, got ${objectHeader.kind}`);

  runTool(ldPath, ['-o', executablePath, '-e', '_start', objectPath]);
  const executableBuffer = exactArrayBuffer(new Uint8Array(await readFile(executablePath)));
  const executableHeader = inspectElfHeader(executableBuffer);
  assert(executableHeader.valid, 'GNU ld output must be a valid ELF');
  assert(executableHeader.architecture === 'x86-64', `linked ELF must be x86-64, got ${executableHeader.architecture}`);
  assert(executableHeader.kind === 'executable', `GNU ld must produce ET_EXEC, got ${executableHeader.kind}`);
  assert((executableHeader.entry ?? 0) > 0, 'linked ELF must expose a non-zero _start entry address');

  const capstone = await loadHeadlessCapstone();
  const execution = runElfHeadless('hello-from-nasm', executableBuffer, {
    capstone,
    maxInstructions: 128,
    sliceInstructions: 32
  });
  assert(execution.snapshot.status === 'exited', `generated ELF should exit, got ${execution.snapshot.status}: ${execution.snapshot.trapReason ?? ''}`);
  assert(execution.snapshot.exitCode === 0, `generated ELF should exit(0), got ${execution.snapshot.exitCode}`);
  assert(execution.snapshot.stdout === 'hello from nasm\n', `unexpected generated ELF stdout: ${JSON.stringify(execution.snapshot.stdout)}`);

  console.log('real NASM + GNU ld smoke: PASS (ET_REL -> ET_EXEC -> Capstone/bounded execution -> stdout + exit(0))');
} finally {
  await rm(work, { recursive: true, force: true });
}
