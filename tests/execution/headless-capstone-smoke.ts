import { runElfHeadless } from '../../src/features/execution/headless/runner';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';
import { makeMinimalStaticElf } from './headless-fixtures';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

const capstone = await loadHeadlessCapstone();
const result = runElfHeadless('fixtures/minimal-static-elf', makeMinimalStaticElf(), {
  capstone,
  maxInstructions: 16
});

assertEqual(result.snapshot.status, 'exited', 'real Capstone ELF status');
assertEqual(result.snapshot.exitCode, 0, 'real Capstone ELF exit code');
assertEqual(result.snapshot.instructionCount, 3, 'real Capstone ELF instruction count');
assertEqual(result.snapshot.provider, 'bounded-x86-64', 'real Capstone ELF provider');

console.log('headless Capstone smoke: PASS (vendored WASM + static ELF, zero UI)');
