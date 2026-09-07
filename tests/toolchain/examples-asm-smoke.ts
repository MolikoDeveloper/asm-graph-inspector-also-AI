import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runElfHeadless } from '../../src/features/execution/headless/runner';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runTool(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nasm = resolve(root, 'public/vendor/toolchain/nasm.3.00.elf');
const ld = resolve(root, 'public/vendor/toolchain/gnu-ld.2.43.50.elf');
const capstone = await loadHeadlessCapstone();
const work = await mkdtemp(resolve(tmpdir(), 'asm-graph-examples-'));

async function build(name: string): Promise<ArrayBuffer> {
  const source = resolve(root, `examples/${name}.asm`);
  const object = resolve(work, `${name}.o`);
  const executable = resolve(work, name);
  runTool(nasm, ['-f', 'elf64', source, '-o', object]);
  runTool(ld, ['-o', executable, '-e', '_start', object]);
  return exactArrayBuffer(new Uint8Array(await readFile(executable)));
}

try {
  const inputElf = await build('input');
  const input = runElfHeadless('input', inputElf, { capstone, stdin: 'Ada\n', maxInstructions: 512, sliceInstructions: 128 });
  assert(input.snapshot.status === 'exited', `input demo should exit, got ${input.snapshot.status}: ${input.snapshot.trapReason ?? ''}`);
  assert(input.snapshot.stdout.includes('Hello, Ada\n'), `input demo stdout mismatch: ${JSON.stringify(input.snapshot.stdout)}`);

  const donutElf = await build('donut');
  const donut = runElfHeadless('donut', donutElf, { capstone, maxInstructions: 180_000, sliceInstructions: 4096 });
  assert(donut.snapshot.status === 'exited', `donut demo should exit, got ${donut.snapshot.status}: ${donut.snapshot.trapReason ?? ''}`);
  assert(donut.snapshot.stdout.includes('\u001b[2J\u001b[H'), 'donut demo should emit ANSI clear/home frames');
  assert(donut.snapshot.stdout.includes('DONUT'), 'donut demo should emit visible donut frames');

  console.log(`example ASM smoke: PASS (interactive stdin + rotating ANSI donut, ${donut.snapshot.instructionCount.toLocaleString()} donut instructions)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
