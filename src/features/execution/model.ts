import type { LoadedImage } from '../binary/model';
import type { ProjectFile } from '../project/model';

export type ExecutionStatus = 'idle' | 'ready' | 'running' | 'paused' | 'exited' | 'halted' | 'trapped';
export type ExecutionProviderKind = 'bounded-x86-64' | 'unicorn-machine' | 'unicorn-linux' | 'asm-source-x86-64' | 'blink-process';
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

export interface ExecutionInstructionSnapshot {
  address: number;
  endAddress: number;
  mnemonic: string;
  operands: string;
  line?: number;
  nodeId?: string;
}

export interface ExecutionRuntimeImageSnapshot {
  name: string;
  role: 'program' | 'interpreter' | 'dependency';
  runtimeAddress: bigint;
  imageAddress: bigint;
  loadBias: bigint;
  confidence: 'fixed-address' | 'known-load-bias' | 'cached-signature' | 'signature';
  signatureBytes: number;
}

export interface ExecutionRuntimeDisassemblySnapshot {
  /**
   * Provider-owned live disassembly around the current process RIP.
   * This is observational debugger state and must never be folded back into
   * the canonical Capstone/static analysis graph.
   */
  source: 'blink-debugger' | 'unicorn-runtime';
  lines: string[];
  currentLine: number;
  image: ExecutionRuntimeImageSnapshot | null;
}

export interface ExecutionCrashInstructionSnapshot {
  address: number;
  endAddress: number;
  bytes: number[];
  mnemonic: string;
  operands: string;
}

/**
 * A fatal guest signal/fault observed at a provider boundary. Blink currently
 * supplies Linux signal metadata; Unicorn traps are surfaced through provider
 * diagnostics until a stable signal translation layer is available.
 */
export interface ExecutionCrashSnapshot {
  signal: number;
  signalName: string;
  signalCode: number;
  exitCode: number;
  runtimeAddress: bigint | null;
  imageName: string | null;
  imageRole: 'program' | 'interpreter' | 'dependency' | null;
  imageAddress: bigint | null;
  loadBias: bigint | null;
  functionName: string | null;
  functionOffset: number | null;
  codeBytes: number[];
  instruction: ExecutionCrashInstructionSnapshot | null;
  isaFamily: string | null;
  evidence: 'blink-headless-signal-clstruct';
}

export type ExecutionEvent =
  | { kind: 'prepared'; message: string }
  | { kind: 'instruction'; address: number; mnemonic: string; operands: string; line?: number; nodeId?: string }
  | { kind: 'trace-gap'; reason: 'non-program-image' | 'runtime-image-unresolved' }
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
  lastInstruction: ExecutionInstructionSnapshot | null;
  runtimeDisassembly: ExecutionRuntimeDisassemblySnapshot | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  trapReason: string | null;
  crash?: ExecutionCrashSnapshot | null;
  providerDiagnostics: ExecutionProviderDiagnostic[];
  events: ExecutionEvent[];
}

export type ExecutionTarget =
  | { kind: 'binary'; file: ProjectFile; image: LoadedImage }
  | { kind: 'asm-source'; file: ProjectFile; source: string };

export interface ExecutionSupport {
  supported: boolean;
  provider: ExecutionProviderKind | null;
  reasons: string[];
  notes: string[];
}
