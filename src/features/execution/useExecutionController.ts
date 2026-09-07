import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCapstone } from '../capstone/capstoneLoader';
import { AsmSourceExecutionSession, asmSourceExecutionSupport } from './asmSourceSession';
import { DEFAULT_EXECUTION_POLICY, type ExecutionSnapshot, type ExecutionSupport, type ExecutionTarget } from './model';
import { BlinkProcessSession } from './blinkProcessSession';
import {
  auditBlinkIsaForFile,
  describeBlinkIsaAuditFailure,
  idleBlinkIsaPreflight,
  type BlinkIsaPreflightState
} from './blinkIsaPreflight';
import { publishBlinkIsaPreflight } from './blinkIsaPreflightMonitor';
import { executionSupport, X86ExecutionSession } from './session';
import { registerActiveExecutionInputSink } from './activeInput';
import { appendExecutionStdin } from './stdinQueue';

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
  crash: null,
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
  const [preflight, setPreflight] = useState<BlinkIsaPreflightState>(() => idleBlinkIsaPreflight());
  const sessionRef = useRef<BrowserExecutionSession | null>(null);
  const runGeneration = useRef(0);

  useEffect(() => {
    publishBlinkIsaPreflight(preflight);
  }, [preflight]);

  useEffect(() => registerActiveExecutionInputSink((text) => {
    const session = sessionRef.current;
    if (!session) return false;
    const appended = appendExecutionStdin(session, text);
    if (appended) setSnapshot(session.snapshot());
    return appended;
  }), []);

  const createSession = useCallback(async (
    target: ExecutionTarget,
    force = false,
    allowIncompatibleIsa = false
  ): Promise<BrowserExecutionSession | null> => {
    const current = sessionRef.current;
    if (!force && current && sameTarget(current, target)) return current;
    const generation = ++runGeneration.current;
    current?.dispose();
    let isaAuditStarted = false;
    let isaAuditFinished = false;
    let isaAuditStartedAt = 0;

    try {
      const support = executionSupportForTarget(target);
      if (!support.supported || !support.provider) throw new Error(support.reasons.join(' '));
      let session: BrowserExecutionSession;
      if (target.kind === 'asm-source') {
        setPreflight(idleBlinkIsaPreflight());
        session = new AsmSourceExecutionSession(target.file, target.source, DEFAULT_EXECUTION_POLICY);
      } else if (support.provider === 'blink-process') {
        isaAuditStarted = true;
        isaAuditStartedAt = performance.now();
        setPreflight({
          ...idleBlinkIsaPreflight(),
          status: 'scanning',
          targetFileId: target.file.id,
          targetName: target.file.name,
          elapsedMs: 0
        });
        const isaAudit = await auditBlinkIsaForFile(target.file, {
          onProgress: (progress) => {
            if (runGeneration.current !== generation) return;
            setPreflight({
              status: 'scanning',
              targetFileId: target.file.id,
              targetName: target.file.name,
              elapsedMs: Math.max(0, performance.now() - isaAuditStartedAt),
              scannedInstructions: progress.scannedInstructions,
              processedBytes: progress.processedBytes,
              totalBytes: progress.totalBytes,
              unsupportedFamilies: progress.unsupportedFamilies,
              evidence: progress.evidence,
              message: progress.unsupportedFamilies.length
                ? `Detected unsupported ISA evidence while scanning ${target.file.name}; the complete executable-byte audit will finish before launch.`
                : null
            });
          }
        });
        if (runGeneration.current !== generation) return null;
        isaAuditFinished = true;
        const elapsedMs = Math.max(0, performance.now() - isaAuditStartedAt);
        const failure = isaAudit.compatible ? null : describeBlinkIsaAuditFailure(target.file.name, isaAudit);
        const diagnosticSuffix = failure && allowIncompatibleIsa
          ? ' Diagnostic probe explicitly requested: compatibility remains failed, but Blink will run in the sandbox so an observed signal/RIP can be captured if the guest reaches the unsupported path.'
          : '';
        setPreflight({
          status: isaAudit.compatible ? 'compatible' : 'incompatible',
          targetFileId: target.file.id,
          targetName: target.file.name,
          elapsedMs,
          scannedInstructions: isaAudit.scannedInstructions,
          processedBytes: isaAudit.decodedBytes + isaAudit.skippedBytes,
          totalBytes: isaAudit.decodedBytes + isaAudit.skippedBytes,
          unsupportedFamilies: isaAudit.unsupportedFamilies,
          evidence: isaAudit.evidence,
          message: failure ? `${failure}${diagnosticSuffix}` : null
        });
        if (failure && !allowIncompatibleIsa) throw new Error(failure);
        session = await BlinkProcessSession.create(target.file, target.image, DEFAULT_EXECUTION_POLICY);
      } else {
        setPreflight(idleBlinkIsaPreflight());
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
      const reason = error instanceof Error ? error.message : String(error);
      if (isaAuditStarted && !isaAuditFinished) {
        setPreflight((currentPreflight) => ({
          ...currentPreflight,
          status: 'error',
          targetFileId: target.file.id,
          targetName: target.file.name,
          elapsedMs: Math.max(0, performance.now() - isaAuditStartedAt),
          message: `Blink ISA preflight failed: ${reason}`
        }));
      }
      sessionRef.current = null;
      setSnapshot(failedSnapshot(target, reason));
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

  const driveRun = useCallback(async (session: BrowserExecutionSession) => {
    if (session.status === 'exited' || session.status === 'halted' || session.status === 'trapped') return;
    const generation = ++runGeneration.current;
    session.markRunning();
    setSnapshot(session.snapshot());

    while (runGeneration.current === generation && session.status === 'running') {
      setSnapshot(session.runSlice(500));
      if (session.status !== 'running') break;
      await nextFrame();
    }
  }, []);

  const run = useCallback(async (target: ExecutionTarget) => {
    const session = await createSession(target, false);
    if (!session) return;
    await driveRun(session);
  }, [createSession, driveRun]);

  /**
   * Explicit diagnostic escape hatch for an ELF already proven incompatible by
   * static ISA preflight. Normal Run remains fail-closed; Probe exists solely to
   * capture the actually observed guest signal/RIP/instruction inside Blink.
   */
  const probe = useCallback(async (target: ExecutionTarget) => {
    if (target.kind !== 'binary') {
      setSnapshot(failedSnapshot(target, 'Diagnostic Probe requires an analyzed binary target.'));
      return;
    }
    const support = executionSupportForTarget(target);
    if (support.provider !== 'blink-process') {
      setSnapshot(failedSnapshot(target, 'Diagnostic Probe is only available for blink-process targets.'));
      return;
    }
    const session = await createSession(target, true, true);
    if (!session) return;
    await driveRun(session);
  }, [createSession, driveRun]);

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
    setPreflight(idleBlinkIsaPreflight());
  }, []);

  return { snapshot, preflight, prepare, step, run, probe, pause, reset, clear };
}
