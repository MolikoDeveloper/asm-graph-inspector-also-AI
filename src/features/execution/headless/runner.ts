import { parseElfImage } from '../../binary/elfParser';
import type { CapstoneModule } from '../../capstone/types';
import type { ProjectFile } from '../../project/model';
import { AsmSourceExecutionSession } from '../asmSourceSession';
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy, type ExecutionSnapshot } from '../model';
import { executionSupport, X86ExecutionSession } from '../session';

export interface HeadlessExecutionOptions {
  stdin?: string;
  maxInstructions?: number;
  sliceInstructions?: number;
  maxMappedBytes?: number;
  stackBytes?: number;
  capstone?: CapstoneModule;
}

export interface HeadlessExecutionResult {
  snapshot: ExecutionSnapshot;
  elapsedMs: number;
}

function policyFromOptions(options: HeadlessExecutionOptions): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    stdin: options.stdin ?? DEFAULT_EXECUTION_POLICY.stdin,
    maxInstructions: options.maxInstructions ?? DEFAULT_EXECUTION_POLICY.maxInstructions,
    maxMappedBytes: options.maxMappedBytes ?? DEFAULT_EXECUTION_POLICY.maxMappedBytes,
    stackBytes: options.stackBytes ?? DEFAULT_EXECUTION_POLICY.stackBytes
  };
}

function terminal(snapshot: ExecutionSnapshot): boolean {
  return snapshot.status === 'exited' || snapshot.status === 'halted' || snapshot.status === 'trapped';
}

function runSession(
  session: {
    markRunning(): void;
    runSlice(maxInstructions?: number): ExecutionSnapshot;
    snapshot(): ExecutionSnapshot;
    dispose(): void;
  },
  sliceInstructions: number
): HeadlessExecutionResult {
  const startedAt = performance.now();
  try {
    let snapshot = session.snapshot();
    if (!terminal(snapshot)) session.markRunning();
    while (!terminal(snapshot)) {
      snapshot = session.runSlice(sliceInstructions);
      if (snapshot.status === 'paused') session.markRunning();
    }
    return { snapshot, elapsedMs: performance.now() - startedAt };
  } finally {
    session.dispose();
  }
}

export function createAsmProjectFile(path: string, source: string): ProjectFile {
  const name = path.split(/[\\/]/).at(-1) || 'program.asm';
  return {
    id: `headless:asm:${path}`,
    path,
    name,
    kind: 'text',
    language: 'asm',
    text: source,
    size: new TextEncoder().encode(source).byteLength,
    updatedAt: 0
  };
}

export function createElfProjectFile(path: string, bytes: ArrayBuffer): ProjectFile {
  const name = path.split(/[\\/]/).at(-1) || 'program';
  return {
    id: `headless:elf:${path}`,
    path,
    name,
    kind: 'binary',
    language: 'binary',
    bytes,
    size: bytes.byteLength,
    updatedAt: 0
  };
}

export function runAsmHeadless(path: string, source: string, options: HeadlessExecutionOptions = {}): HeadlessExecutionResult {
  const file = createAsmProjectFile(path, source);
  const session = new AsmSourceExecutionSession(file, source, policyFromOptions(options));
  return runSession(session, Math.max(1, options.sliceInstructions ?? 2048));
}

export function runElfHeadless(path: string, bytes: ArrayBuffer, options: HeadlessExecutionOptions = {}): HeadlessExecutionResult {
  const file = createElfProjectFile(path, bytes);
  const image = parseElfImage(file.id, file.path, bytes);
  const support = executionSupport(image);
  if (!support.supported) throw new Error(support.reasons.join(' '));
  if (support.provider !== 'bounded-x86-64') {
    const detail = support.notes.length ? ` ${support.notes.join(' ')}` : '';
    throw new Error(`Headless ELF execution currently requires a static fixed-address ELF handled by bounded-x86-64; provider ${support.provider ?? 'none'} was selected.${detail}`);
  }
  if (!options.capstone) throw new Error('Headless ELF execution requires a Capstone module. Pass options.capstone from the headless Capstone loader.');
  const session = new X86ExecutionSession(file, image, options.capstone, policyFromOptions(options));
  return runSession(session, Math.max(1, options.sliceInstructions ?? 2048));
}

export function isElfBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}
