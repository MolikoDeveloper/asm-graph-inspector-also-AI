import { useCallback, useRef, useState } from 'react';
import { loadCapstone } from '../capstone/capstoneLoader';
import { AsmSourceExecutionSession, asmSourceExecutionSupport } from './asmSourceSession';
import { DEFAULT_EXECUTION_POLICY, type ExecutionSnapshot, type ExecutionSupport, type ExecutionTarget } from './model';
import { BlinkProcessSession } from './blinkProcessSession';
import { executionSupport, X86ExecutionSession } from './session';

type BrowserExecutionSession = X86ExecutionSession | AsmSourceExecutionSession | BlinkProcessSession;

const IDLE_SNAPSHOT: ExecutionSnapshot = {
  status: 'idle',
  targetFileId: null,
  targetName: null,
  imageKind: null,
  provider: null,
  instructionCount: 0,
  registers: null,
  lastInstruction: null,
  runtimeDisassembly: null,
  stdout: '',
  stderr: '',
  exitCode: null,
  trapReason: null,
  providerDiagnostics: [],
  events: []
};

export function executionSupportForTarget(target: ExecutionTarget): ExecutionSupport {
  return target.kind === 'binary' ? executionSupport(target.image) : asmSourceExecutionSupport(target.file, target.source);
}

function failedSnapshot(target: ExecutionTarget, reason: string): ExecutionSnapshot {
  return {
    ...IDLE_SNAPSHOT,
    status: 'trapped',
    targetFileId: target.file.id,
    targetName: target.file.name,
    imageKind: target.kind === 'binary' ? target.image.kind : null,
    trapReason: reason,
    events: [{ kind: 'trap', reason }]
  };
}

function sameTarget(session: BrowserExecutionSession, target: ExecutionTarget): boolean {
  if (session.file.id !== target.file.id) return false;
  if (target.kind === 'asm-source') return session instanceof AsmSourceExecutionSession && session.source === target.source;
  if (session instanceof AsmSourceExecutionSession) return false;
  return session.image.entry === target.image.entry && session.image.kind === target.image.kind;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

export function useExecutionController() {
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot>(IDLE_SNAPSHOT);
  const sessionRef = useRef<BrowserExecutionSession | null>(null);
  const runGeneration = useRef(0);

  const createSession = useCallback(async (target: ExecutionTarget, force = false): Promise<BrowserExecutionSession | null> => {
    const current = sessionRef.current;
    if (!force && current && sameTarget(current, target)) return current;
    const generation = ++runGeneration.current;
    current?.dispose();
    try {
      const support = executionSupportForTarget(target);
      if (!support.supported || !support.provider) throw new Error(support.reasons.join(' '));
      let session: BrowserExecutionSession;
      if (target.kind === 'asm-source') {
        session = new AsmSourceExecutionSession(target.file, target.source, DEFAULT_EXECUTION_POLICY);
      } else if (support.provider === 'blink-process') {
        session = await BlinkProcessSession.create(target.file, target.image, DEFAULT_EXECUTION_POLICY);
      } else {
        session = new X86ExecutionSession(target.file, target.image, await loadCapstone(), DEFAULT_EXECUTION_POLICY);
      }
      if (runGeneration.current !== generation) {
        session.dispose();
        return null;
      }
      sessionRef.current = session;
      setSnapshot(session.snapshot());
      return session;
    } catch (error: unknown) {
      if (runGeneration.current !== generation) return null;
      sessionRef.current = null;
      setSnapshot(failedSnapshot(target, error instanceof Error ? error.message : String(error)));
      return null;
    }
  }, []);

  const prepare = useCallback(async (target: ExecutionTarget) => {
    await createSession(target, true);
  }, [createSession]);

  const step = useCallback(async (target: ExecutionTarget) => {
    runGeneration.current += 1;
    const session = await createSession(target, false);
    if (!session) return;
    session.pause();
    setSnapshot(session.step());
  }, [createSession]);

  const run = useCallback(async (target: ExecutionTarget) => {
    const session = await createSession(target, false);
    if (!session) return;
    if (session.status === 'exited' || session.status === 'halted' || session.status === 'trapped') return;
    const generation = ++runGeneration.current;
    session.markRunning();
    setSnapshot(session.snapshot());

    while (runGeneration.current === generation && session.status === 'running') {
      setSnapshot(session.runSlice(500));
      if (session.status !== 'running') break;
      await nextFrame();
    }
  }, [createSession]);

  const pause = useCallback(() => {
    runGeneration.current += 1;
    const session = sessionRef.current;
    if (!session) return;
    session.pause();
    setSnapshot(session.snapshot());
  }, []);

  const reset = useCallback(async (target: ExecutionTarget) => {
    await createSession(target, true);
  }, [createSession]);

  const clear = useCallback(() => {
    runGeneration.current += 1;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSnapshot(IDLE_SNAPSHOT);
  }, []);

  return { snapshot, prepare, step, run, pause, reset, clear };
}
