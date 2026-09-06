import { analyzeAssemblyChecked } from '../../src/features/analysis/asmParser';
import { AsmSourceExecutionSession } from '../../src/features/execution/asmSourceSession';
import { projectExecutionTrace } from '../../src/features/execution/follow';
import { DEFAULT_EXECUTION_POLICY } from '../../src/features/execution/model';
import type { ProjectFile } from '../../src/features/project/model';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertOk(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`${label}: expected truthy value`);
}

const source = `bits 64
section .data
msg: db "hola!\\n"
section .text
global _start
_start:
  mov ecx, 3
.loop:
  dec ecx
  jne .loop
  mov eax, 1
  mov edi, 1
  mov rsi, msg
  mov edx, 6
  syscall
  mov eax, 60
  xor edi, edi
  syscall
`;

const file: ProjectFile = {
  id: 'raw-asm-smoke',
  path: 'fixtures/raw-asm-smoke.asm',
  name: 'raw-asm-smoke.asm',
  kind: 'text',
  language: 'asm',
  text: source,
  size: new TextEncoder().encode(source).length,
  updatedAt: 1
};

const analysis = analyzeAssemblyChecked(file.id, source);
assertEqual(analysis.valid, true, 'source analysis valid');

const session = new AsmSourceExecutionSession(file, source, {
  ...DEFAULT_EXECUTION_POLICY,
  maxInstructions: 100,
  maxMappedBytes: 4 * 1024 * 1024,
  stackBytes: 64 * 1024
});

try {
  const prepared = session.snapshot();
  assertEqual(prepared.status, 'ready', 'prepared status');
  assertEqual(prepared.provider, 'asm-source-x86-64', 'provider');

  const first = session.step();
  assertEqual(first.status, 'paused', 'first step status');
  assertEqual(first.lastInstruction?.line, 7, 'first source line');
  assertEqual(first.lastInstruction?.nodeId, `${file.id}:insn:7`, 'first graph node');
  assertEqual(first.registers?.rcx, 3n, 'ECX initialization');

  session.markRunning();
  let snapshot = session.snapshot();
  while (session.status === 'running') snapshot = session.runSlice(32);

  assertEqual(snapshot.status, 'exited', 'final status');
  assertEqual(snapshot.exitCode, 0, 'exit code');
  assertEqual(snapshot.stdout, 'hola!\n', 'virtual stdout');
  assertEqual(snapshot.stderr, '', 'virtual stderr');
  assertOk(snapshot.events.some((event) => event.kind === 'syscall' && event.name === 'write'), 'write syscall event');
  assertOk(snapshot.events.some((event) => event.kind === 'exit' && event.code === 0), 'exit event');

  const trace = projectExecutionTrace(analysis.graph, snapshot);
  assertEqual(trace.nodeCounts.get(`${file.id}:insn:9`), 3, 'loop dec execution count');
  assertEqual(trace.nodeCounts.get(`${file.id}:insn:10`), 3, 'loop branch execution count');
  assertOk([...trace.edgeCounts.values()].some((count) => count >= 2), 'observed loop edge count');

  console.log('raw ASM source smoke: PASS (loop -> Linux Lite write -> exit(0) -> execution trace)');

const unsupportedSource = `bits 64
_start:
  mov eax, 999
  syscall
`;
const unsupportedFile: ProjectFile = { ...file, id: 'raw-asm-unsupported', name: 'raw-asm-unsupported.asm', path: 'fixtures/raw-asm-unsupported.asm', text: unsupportedSource, size: new TextEncoder().encode(unsupportedSource).length };
const unsupportedSession = new AsmSourceExecutionSession(unsupportedFile, unsupportedSource, { ...DEFAULT_EXECUTION_POLICY, maxInstructions: 8, maxMappedBytes: 4 * 1024 * 1024, stackBytes: 64 * 1024 });
try {
  unsupportedSession.markRunning();
  const trapped = unsupportedSession.runSlice(8);
  assertEqual(trapped.status, 'trapped', 'unsupported syscall status');
  assertOk(trapped.trapReason?.includes('Linux Lite syscall 999'), 'unsupported syscall trap reason');
} finally {
  unsupportedSession.dispose();
}

} finally {
  session.dispose();
}
