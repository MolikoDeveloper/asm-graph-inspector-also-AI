import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCapstone } from '../capstone/capstoneLoader';
import { AsmSourceExecutionSession, asmSourceExecutionSupport } from './asmSourceSession';
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy, type ExecutionSnapshot, type ExecutionSupport, type ExecutionTarget } from './model';
import { BlinkProcessSession } from './blinkProcessSession';
import {
  auditBlinkIsaForFile,
  describeBlinkIsaAuditFailure,
  idleBlinkIsaPreflight,
  type BlinkIsaPreflightState
} from './blinkIsaPreflight';
import { publishBlinkIsaPreflight } from './blinkIsaPreflightMonitor';
import { prepareBlinkRuntimeEnvironment } from './runtimeEnvironment';
import {
  describeBlinkRuntimeIsaAdvisory,
  describeBlinkRuntimeIsaFailure
} from './runtimeIsaAudit';
import { describeRuntimeSymbolVersionFailure } from './runtimeSymbolVersions';
import { prepareLinuxRuntimeEnvironment } from './linuxRuntimeEnvironment';
import { executionSupport, X86ExecutionSession } from './session';
import { UnicornMachineSession } from './unicornMachineSession';
import { UnicornLinuxProcessSession } from './unicornLinuxProcessSession';
import { registerActiveExecutionInputSink } from './activeInput';
import { registerActiveExecutionProbeSink } from './activeProbe';
import { appendExecutionStdin } from './stdinQueue';

type BrowserExecutionSession = X86ExecutionSession | UnicornMachineSession | UnicornLinuxProcessSession | AsmSourceExecutionSession | BlinkProcessSession;

const UNICORN_LINUX_POLICY: ExecutionPolicy = Object.freeze({
  ...DEFAULT_EXECUTION_POLICY,
  maxInstructions: Math.max(DEFAULT_EXECUTION_POLICY.maxInstructions, 2_000_000),
  maxMappedBytes: Math.max(DEFAULT_EXECUTION_POLICY.maxMappedBytes, 256 * 1024 * 1024)
});

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
  if (target.kind !== 'binary') return asmSourceExecutionSupport(target.file, target.source);
  const support = executionSupport(target.image);
  if (!support.supported) return support;
  const dynamic = target.image.kind === 'pie-executable' || !!target.image.interpreter || target.image.neededLibraries.length > 0;
  return {
    ...support,
    provider: dynamic ? 'unicorn-linux' : 'unicorn-machine',
    notes: dynamic
      ? [
          'Linux ELF will use the kernel-less Unicorn/WASM process backend.',
          ...(target.image.interpreter ? [`PT_INTERP ${target.image.interpreter} will execute from the selected Global Dependency bytes.`] : []),
          ...(target.image.neededLibraries.length ? [`${target.image.neededLibraries.length} direct DT_NEEDED entr${target.image.neededLibraries.length === 1 ? 'y' : 'ies'} will be resolved recursively from Global Dependencies.`] : [])
        ]
      : ['Static fixed-address ELF will use the Unicorn/WASM x86-64 machine backend.']
  };
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
  // Retained for the explicit Blink diagnostic probe. Normal guest execution no
  // longer gates on Blink's CPU profile because Unicorn owns the execution path.
  const [preflight, setPreflight] = useState<BlinkIsaPreflightState>(() => idleBlinkIsaPreflight());
  const sessionRef = useRef<BrowserExecutionSession | null>(null);
  const lastTargetRef = useRef<ExecutionTarget | null>(null);
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
    force = false
  ): Promise<BrowserExecutionSession | null> => {
    lastTargetRef.current = target;
    const current = sessionRef.current;
    if (!force && current && sameTarget(current, target)) return current;
    const generation = ++runGeneration.current;
    current?.dispose();
    sessionRef.current = null;

    try {
      const support = executionSupportForTarget(target);
      if (!support.supported || !support.provider) throw new Error(support.reasons.join(' '));
      let session: BrowserExecutionSession;
      setPreflight(idleBlinkIsaPreflight());

      if (target.kind === 'asm-source') {
        session = new AsmSourceExecutionSession(target.file, target.source, DEFAULT_EXECUTION_POLICY);
      } else if (support.provider === 'unicorn-linux') {
        const runtimeEnvironment = await prepareLinuxRuntimeEnvironment(target.file, target.image);
        if (runGeneration.current !== generation) return null;
        if (!runtimeEnvironment.symbolVersions.compatible) {
          throw new Error(describeRuntimeSymbolVersionFailure(runtimeEnvironment.symbolVersions));
        }
        session = await UnicornLinuxProcessSession.create(
          target.file,
          target.image,
          runtimeEnvironment,
          UNICORN_LINUX_POLICY
        );
      } else if (support.provider === 'unicorn-machine') {
        session = await UnicornMachineSession.create(target.file, target.image, DEFAULT_EXECUTION_POLICY);
      } else {
        // Deliberate legacy/reference fallback. Browser routing above selects a
        // Unicorn provider for every supported binary target.
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
   * Blink is retained as an explicit reference/diagnostic backend. It is not
   * selected by normal Run/Step. Probe intentionally repeats Blink-specific ISA
   * evidence and captures its signal/RIP diagnostics for backend comparison.
   */
  const probe = useCallback(async (target: ExecutionTarget) => {
    if (target.kind !== 'binary') {
      setSnapshot(failedSnapshot(target, 'Diagnostic Probe requires an analyzed binary target.'));
      return;
    }

    lastTargetRef.current = target;
    const generation = ++runGeneration.current;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    const startedAt = performance.now();

    try {
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
            elapsedMs: Math.max(0, performance.now() - startedAt),
            scannedInstructions: progress.scannedInstructions,
            processedBytes: progress.processedBytes,
            totalBytes: progress.totalBytes,
            unsupportedFamilies: progress.unsupportedFamilies,
            evidence: progress.evidence,
            message: progress.unsupportedFamilies.length
              ? `Detected unsupported Blink ISA evidence while scanning ${target.file.name}; Probe will continue to capture observed runtime evidence.`
              : null
          });
        }
      });
      if (runGeneration.current !== generation) return;
      const failure = isaAudit.compatible ? null : describeBlinkIsaAuditFailure(target.file.name, isaAudit);
      setPreflight({
        status: isaAudit.compatible ? 'compatible' : 'incompatible',
        targetFileId: target.file.id,
        targetName: target.file.name,
        elapsedMs: Math.max(0, performance.now() - startedAt),
        scannedInstructions: isaAudit.scannedInstructions,
        processedBytes: isaAudit.decodedBytes + isaAudit.skippedBytes,
        totalBytes: isaAudit.decodedBytes + isaAudit.skippedBytes,
        unsupportedFamilies: isaAudit.unsupportedFamilies,
        evidence: isaAudit.evidence,
        message: failure ? `${failure} Blink Probe will still run to collect observed signal/RIP evidence.` : null
      });

      const runtimeEnvironment = await prepareBlinkRuntimeEnvironment(target.file, target.image);
      if (runGeneration.current !== generation) return;
      if (!runtimeEnvironment.symbolVersions.compatible) {
        throw new Error(describeRuntimeSymbolVersionFailure(runtimeEnvironment.symbolVersions));
      }
      const runtimeIsaMessage = !runtimeEnvironment.runtimeIsa.compatible
        ? `${describeBlinkRuntimeIsaFailure(runtimeEnvironment.runtimeIsa)} Blink Probe will still run to capture observed evidence.`
        : describeBlinkRuntimeIsaAdvisory(runtimeEnvironment.runtimeIsa);
      if (runtimeIsaMessage) {
        setPreflight((currentPreflight) => ({
          ...currentPreflight,
          message: currentPreflight.message ? `${currentPreflight.message} ${runtimeIsaMessage}` : runtimeIsaMessage
        }));
      }

      const session = await BlinkProcessSession.create(
        target.file,
        target.image,
        DEFAULT_EXECUTION_POLICY,
        undefined,
        runtimeEnvironment
      );
      if (runGeneration.current !== generation) { session.dispose(); return; }
      sessionRef.current = session;
      setSnapshot(session.snapshot());
      await driveRun(session);
    } catch (error: unknown) {
      if (runGeneration.current !== generation) return;
      const reason = error instanceof Error ? error.message : String(error);
      setSnapshot(failedSnapshot(target, reason));
    }
  }, [driveRun]);

  useEffect(() => registerActiveExecutionProbeSink(() => {
    const target = lastTargetRef.current;
    if (!target) return false;
    void probe(target);
    return true;
  }), [probe]);

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
    lastTargetRef.current = null;
    setSnapshot(IDLE_SNAPSHOT);
    setPreflight(idleBlinkIsaPreflight());
  }, []);

  return { snapshot, preflight, prepare, step, run, probe, pause, reset, clear };
}
