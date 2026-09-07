import { deriveAssemblyBuildTelemetry } from '../../src/features/execution/debugTelemetry';
import { appendExecutionStdin } from '../../src/features/execution/stdinQueue';
import { renderVirtualTerminal } from '../../src/features/execution/virtualTerminal';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

assertEqual(renderVirtualTerminal('old frame\n\u001b[2J\u001b[Hdonut\n'), 'donut', 'ANSI clear/home');
assertEqual(renderVirtualTerminal('abc\rZ'), 'Zbc', 'carriage-return overwrite');
assertEqual(renderVirtualTerminal('hello\u001b[2K\rbye'), 'bye', 'erase current line');

const fakeQueue = {
  stdinBytes: new TextEncoder().encode('abc'),
  stdinCursor: 2
};
assert(appendExecutionStdin(fakeQueue, 'XY'), 'stdin append should succeed');
assertEqual(new TextDecoder().decode(fakeQueue.stdinBytes), 'cXY', 'stdin append preserves unread suffix');
assertEqual(fakeQueue.stdinCursor, 0, 'stdin cursor resets after compaction');

const building = deriveAssemblyBuildTelemetry([
  { time: 1000, level: 'info', message: 'Assembling examples/donut.asm with pinned NASM + GNU ld…' }
], 1450);
assertEqual(building.status, 'building', 'build in progress');
assertEqual(building.elapsedMs, 450, 'live build elapsed');

const built = deriveAssemblyBuildTelemetry([
  { time: 1000, level: 'info', message: 'Preparing real ELF for examples/donut.asm…' },
  { time: 1275, level: 'success', message: 'Built examples/donut.asm → build/donut.elf: 4096 bytes.' }
], 1500);
assertEqual(built.status, 'success', 'build completed');
assertEqual(built.elapsedMs, 275, 'completed build elapsed');

console.log('virtual terminal smoke: PASS (ANSI screen + live stdin queue + ASM build telemetry)');
