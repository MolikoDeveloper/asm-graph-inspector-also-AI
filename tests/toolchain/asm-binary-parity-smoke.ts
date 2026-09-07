import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsmHeadless, runElfHeadless } from '../../src/features/execution/headless/runner';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runTool(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed with ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const sourcePath = resolve(root, 'tests/toolchain/fixtures/hello-world.asm');
const nasmPath = resolve(root, 'public/vendor/toolchain/nasm.3.00.elf');
const ldPath = resolve(root, 'public/vendor/toolchain/gnu-ld.2.43.50.elf');
const source = await readFile(sourcePath, 'utf8');

const legacy = runAsmHeadless('hello-world.asm', source, {
  maxInstructions: 128,
  sliceInstructions: 32,
  maxMappedBytes: 4 * 1024 * 1024,
  stackBytes: 64 * 1024
});
assert(legacy.snapshot.status === 'exited', `legacy ASM should exit, got ${legacy.snapshot.status}: ${legacy.snapshot.trapReason ?? ''}`);
assert(legacy.snapshot.exitCode === 0, `legacy ASM should exit(0), got ${legacy.snapshot.exitCode}`);

const work = await mkdtemp(resolve(tmpdir(), 'asm-graph-parity-'));
try {
  const objectPath = resolve(work, 'hello.o');
  const executablePath = resolve(work, 'hello');
  runTool(nasmPath, ['-f', 'elf64', sourcePath, '-o', objectPath]);
  runTool(ldPath, ['-o', executablePath, '-e', '_start', objectPath]);

  const executableBytes = new Uint8Array(await readFile(executablePath));
  const executableBuffer = executableBytes.buffer.slice(
    executableBytes.byteOffset,
    executableBytes.byteOffset + executableBytes.byteLength
  );
  const binary = runElfHeadless('hello-world', executableBuffer, {
    capstone: await loadHeadlessCapstone(),
    maxInstructions: 128,
    sliceInstructions: 32
  });

  assert(binary.snapshot.status === 'exited', `compiled ELF should exit, got ${binary.snapshot.status}: ${binary.snapshot.trapReason ?? ''}`);
  assert(binary.snapshot.exitCode === legacy.snapshot.exitCode, 'compiled ELF and legacy ASM must agree on exit code for parity fixture');
  assert(binary.snapshot.stdout === legacy.snapshot.stdout, `compiled ELF stdout must match legacy ASM: ${JSON.stringify(binary.snapshot.stdout)} vs ${JSON.stringify(legacy.snapshot.stdout)}`);
  assert(binary.snapshot.stderr === legacy.snapshot.stderr, 'compiled ELF stderr must match legacy ASM');
  assert(binary.snapshot.provider === 'bounded-x86-64', `compiled execution must use binary provider, got ${binary.snapshot.provider}`);
  assert((binary.snapshot.lastInstruction?.address ?? 0) >= 0x400000, 'compiled execution trace must use real linked ELF addresses');

  console.log('ASM binary parity smoke: PASS (legacy semantics == NASM/ld ELF output/exit, binary path uses real addresses)');
} finally {
  await rm(work, { recursive: true, force: true });
}
