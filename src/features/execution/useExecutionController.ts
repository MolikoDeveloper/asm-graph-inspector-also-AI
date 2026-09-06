import { useCallback, useRef, useState } from 'react';
import type { LoadedImage } from '../binary/model';
import { loadCapstone } from '../capstone/capstoneLoader';
import type { ProjectFile } from '../project/model';
import { DEFAULT_EXECUTION_POLICY, type ExecutionSnapshot } from './model';
import { BlinkProcessSession } from './blinkProcessSession';
import { executionSupport, X86ExecutionSession } from './session';

type BrowserExecutionSession = X86ExecutionSession | BlinkProcessSession;

const IDLE_SNAPSHOT: ExecutionSnapshot = {
  status: 'idle',
  targetFileId: null,
  targetName: null,
  imageKind: null,
  provider: null,
  instructionCount: 0,
  registers: null,
  lastInstruction: null,
  stdout: '',
  stderr: '',
  exitCode: null,
  trapReason: null,
  providerDiagnostics: [],
  events: []
};

function failedSnapshot(file: ProjectFile, image: LoadedImage, reason: string): ExecutionSnapshot {
  return {
    ...IDLE_SNAPSHOT,
    status: 'trapped',
    targetFileId: file.id,
    targetName: file.name,
    imageKind: image.kind,
    trapReason: reason,
    events: [{ kind: 'trap', reason }]
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

export function useExecutionController() {
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot>(IDLE_SNAPSHOT);
  const sessionRef = useRef<BrowserExecutionSession | null>(null);
  const runGeneration = useRef(0);

  const createSession = useCallback(async (file: ProjectFile, image: LoadedImage, force = false): Promise<BrowserExecutionSession | null> => {
    const current = sessionRef.current;
    if (!force && current && current.file.id === file.id && current.image.entry === image.entry) return current;
    const generation = ++runGeneration.current;
    current?.dispose();
    try {
      const support = executionSupport(image);
      if (!support.supported || !support.provider) throw new Error(support.reasons.join(' '));
      const session: BrowserExecutionSession = support.provider === 'blink-process'
        ? await BlinkProcessSession.create(file, image, DEFAULT_EXECUTION_POLICY)
        : new X86ExecutionSession(file, image, await loadCapstone(), DEFAULT_EXECUTION_POLICY);
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
      setSnapshot(failedSnapshot(file, image, error instanceof Error ? error.message : String(error)));
      return null;
    }
  }, []);

  const prepare = useCallback(async (file: ProjectFile, image: LoadedImage) => {
    await createSession(file, image, true);
  }, [createSession]);

  const step = useCallback(async (file: ProjectFile, image: LoadedImage) => {
    runGeneration.current += 1;
    const session = await createSession(file, image, false);
    if (!session) return;
    session.pause();
    setSnapshot(session.step());
  }, [createSession]);

  const run = useCallback(async (file: ProjectFile, image: LoadedImage) => {
    const session = await createSession(file, image, false);
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

  const reset = useCallback(async (file: ProjectFile, image: LoadedImage) => {
    await createSession(file, image, true);
  }, [createSession]);

  const clear = useCallback(() => {
    runGeneration.current += 1;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSnapshot(IDLE_SNAPSHOT);
  }, []);

  return { snapshot, prepare, step, run, pause, reset, clear };
}
