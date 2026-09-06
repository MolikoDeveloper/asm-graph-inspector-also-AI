import type { CanonicalInstruction, LoadedImage } from '../binary/model';

export type ExecutionStatus = 'idle' | 'ready' | 'running' | 'paused' | 'exited' | 'halted' | 'trapped';
export type ExecutionProviderKind = 'bounded-x86-64' | 'blink-process';
export type ExecutionSyscallPolicy = 'none' | 'stdio-exit';

export interface ExecutionPolicy {
  maxInstructions: number;
  maxMappedBytes: number;
  stackBytes: number;
  syscallPolicy: ExecutionSyscallPolicy;
  stdin: string;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = Object.freeze({
  maxInstructions: 250_000,
  maxMappedBytes: 128 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  syscallPolicy: 'stdio-exit',
  stdin: ''
});

export interface ExecutionRegisterSnapshot {
  rax: bigint;
  rbx: bigint;
  rcx: bigint;
  rdx: bigint;
  rsi: bigint;
  rdi: bigint;
  rbp: bigint;
  rsp: bigint;
  rip: bigint;
  r8: bigint;
  r9: bigint;
  r10: bigint;
  r11: bigint;
  r12: bigint;
  r13: bigint;
  r14: bigint;
  r15: bigint;
  rflags: bigint;
}

export interface ExecutionProviderDiagnostic {
  level: 'info' | 'warning' | 'error';
  message: string;
  count: number;
}

export type ExecutionEvent =
  | { kind: 'prepared'; message: string }
  | { kind: 'instruction'; address: number; mnemonic: string; operands: string }
  | { kind: 'stdout'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'syscall'; number: number; name: string; detail: string }
  | { kind: 'exit'; code: number }
  | { kind: 'halt'; reason: string }
  | { kind: 'trap'; reason: string }
  | { kind: 'provider-diagnostic'; level: ExecutionProviderDiagnostic['level']; message: string };

export interface ExecutionSnapshot {
  status: ExecutionStatus;
  targetFileId: string | null;
  targetName: string | null;
  imageKind: LoadedImage['kind'] | null;
  provider: ExecutionProviderKind | null;
  instructionCount: number;
  registers: ExecutionRegisterSnapshot | null;
  lastInstruction: CanonicalInstruction | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  trapReason: string | null;
  providerDiagnostics: ExecutionProviderDiagnostic[];
  events: ExecutionEvent[];
}

export interface ExecutionSupport {
  supported: boolean;
  provider: ExecutionProviderKind | null;
  reasons: string[];
  notes: string[];
}
