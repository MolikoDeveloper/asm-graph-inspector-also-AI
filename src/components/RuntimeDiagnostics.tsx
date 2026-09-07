import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlinkIsaPreflightState } from '../features/execution/blinkIsaPreflight';
import type { ExecutionSnapshot, ExecutionSupport } from '../features/execution/model';
import { deriveAssemblyBuildTelemetry, type DebugLogEntryLike } from '../features/execution/debugTelemetry';
import { renderVirtualTerminal } from '../features/execution/virtualTerminal';
import './RuntimeDiagnostics.css';

function hex(value: bigint | null | undefined): string {
  return value === null || value === undefined ? '—' : `0x${value.toString(16).padStart(16, '0')}`;
}

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(3)} s`;
}

function bytesHex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

const REGISTER_NAMES = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'] as const;

export function RuntimeDiagnostics({
  snapshot,
  preflight,
  support,
  targetName,
  buildEntries,
  showProcessOutput
}: {
  snapshot: ExecutionSnapshot;
  preflight: BlinkIsaPreflightState;
  support: ExecutionSupport | null;
  targetName: string | null;
  buildEntries: readonly DebugLogEntryLike[];
  showProcessOutput: boolean;
}) {
  const [clock, setClock] = useState(0);
  const [runElapsedMs, setRunElapsedMs] = useState<number | null>(null);
  const runStartedAt = useRef<number | null>(null);
  const previousStatus = useRef(snapshot.status);

  const buildTelemetry = useMemo(() => deriveAssemblyBuildTelemetry(buildEntries, Date.now()), [buildEntries, clock]);
  const mergedOutput = useMemo(() => {
    const combined = `${snapshot.stdout}${snapshot.stderr}`;
    return combined ? renderVirtualTerminal(combined, { columns: 120, rows: 64 }) : '';
  }, [snapshot.stderr, snapshot.stdout]);

  useEffect(() => {
    if (buildTelemetry.status !== 'building' && snapshot.status !== 'running' && preflight.status !== 'scanning') return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 80);
    return () => window.clearInterval(timer);
  }, [buildTelemetry.status, preflight.status, snapshot.status]);

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = snapshot.status;
    if (snapshot.status === 'running' && previous !== 'running') {
      runStartedAt.current = performance.now();
      setRunElapsedMs(null);
      return;
    }
    if ((snapshot.status === 'exited' || snapshot.status === 'halted' || snapshot.status === 'trapped') && runStartedAt.current !== null) {
      setRunElapsedMs(Math.max(0, performance.now() - runStartedAt.current));
      runStartedAt.current = null;
    }
  }, [snapshot.status]);

  useEffect(() => {
    runStartedAt.current = null;
    setRunElapsedMs(null);
    previousStatus.current = snapshot.status;
  }, [snapshot.targetFileId]);

  const liveElapsed = snapshot.status === 'running' && runStartedAt.current !== null
    ? performance.now() - runStartedAt.current
    : runElapsedMs;
  const preflightLabel = preflight.status === 'idle'
    ? 'idle'
    : `${preflight.status}${preflight.elapsedMs !== null ? ` · ${duration(preflight.elapsedMs)}` : ''}`;
  const buildLabel = buildTelemetry.status === 'idle'
    ? 'idle'
    : `${buildTelemetry.status}${buildTelemetry.elapsedMs !== null ? ` · ${duration(buildTelemetry.elapsedMs)}` : ''}`;
  const registers = snapshot.registers;
  const crash = snapshot.crash;

  return (
    <div className="runtime-diagnostics">
      <header className="runtime-diagnostics-header">
        <div>
          <strong>{targetName ?? 'No target selected'}</strong>
          <span className={`runtime-diagnostics-status ${snapshot.status}`}>{snapshot.status}</span>
          {snapshot.provider || support?.provider ? <code>{snapshot.provider ?? support?.provider}</code> : null}
        </div>
        <span>{snapshot.instructionCount.toLocaleString()} stepped instruction{snapshot.instructionCount === 1 ? '' : 's'}</span>
      </header>

      <div className="runtime-diagnostics-scroll">
        <section className="runtime-summary-grid">
          <span><b>Build</b><code>{buildLabel}</code></span>
          <span><b>ISA preflight</b><code className={`preflight-${preflight.status}`}>{preflightLabel}</code></span>
          <span><b>Execution</b><code>{duration(liveElapsed)}</code></span>
          <span><b>Exit</b><code>{snapshot.exitCode === null ? '—' : String(snapshot.exitCode)}</code></span>
        </section>

        {support && !support.supported ? (
          <section className="runtime-diagnostic-block error">
            <strong>Execution refused</strong>
            {support.reasons.map((reason) => <p key={reason}>{reason}</p>)}
          </section>
        ) : null}

        {preflight.status !== 'idle' ? (
          <details className={`runtime-diagnostic-details ${preflight.status}`} open={preflight.status === 'incompatible' || preflight.status === 'error'}>
            <summary>Static Blink ISA preflight · {preflightLabel}</summary>
            <div className="runtime-diagnostic-detail-body">
              <p>{preflight.scannedInstructions.toLocaleString()} decoded instruction(s) · {preflight.unsupportedFamilies.length ? `unsupported: ${preflight.unsupportedFamilies.join(', ')}` : 'no unsupported ISA evidence'}</p>
              {preflight.evidence.slice(0, 8).map((item, index) => (
                <code key={`${item.address}:${item.mnemonic}:${index}`}>0x{item.address.toString(16)} · {item.mnemonic}{item.operands ? ` ${item.operands}` : ''} · [{bytesHex(item.bytes)}] · {item.family}</code>
              ))}
              {preflight.message ? <p>{preflight.message}</p> : null}
            </div>
          </details>
        ) : null}

        {registers ? (
          <section className="runtime-register-panel">
            <div className="runtime-register-head">
              <span><b>RIP</b><code>{hex(registers.rip)}</code></span>
              <span><b>RSP</b><code>{hex(registers.rsp)}</code></span>
              <span><b>RFLAGS</b><code>{hex(registers.rflags)}</code></span>
            </div>
            <div className="runtime-register-grid">
              {REGISTER_NAMES.map((name) => <span key={name}><b>{name.toUpperCase()}</b><code>{hex(registers[name])}</code></span>)}
            </div>
          </section>
        ) : null}

        {crash ? (
          <section className="runtime-diagnostic-block crash">
            <div className="runtime-crash-heading"><strong>Observed runtime failure</strong><code>{crash.signalName} · signal {crash.signal} · exit {crash.exitCode}</code></div>
            <div className="runtime-crash-grid">
              <span><b>Runtime RIP</b><code>{hex(crash.runtimeAddress)}</code></span>
              <span><b>Image</b><code>{crash.imageName ?? 'unresolved'}{crash.imageRole ? ` · ${crash.imageRole}` : ''}</code></span>
              <span><b>ELF address</b><code>{hex(crash.imageAddress)}</code></span>
              <span><b>Function</b><code>{crash.functionName ? `${crash.functionName}${crash.functionOffset ? `+0x${crash.functionOffset.toString(16)}` : ''}` : 'unresolved'}</code></span>
            </div>
            {crash.instruction ? <pre>0x{crash.instruction.address.toString(16)}  {crash.instruction.mnemonic}{crash.instruction.operands ? ` ${crash.instruction.operands}` : ''}\n{bytesHex(crash.instruction.bytes)}</pre> : null}
          </section>
        ) : null}

        {snapshot.providerDiagnostics.length ? (
          <details className="runtime-diagnostic-details provider" open={snapshot.status === 'trapped'}>
            <summary>Provider diagnostics · {snapshot.providerDiagnostics.reduce((total, item) => total + item.count, 0)} event(s)</summary>
            <div className="runtime-provider-list">
              {snapshot.providerDiagnostics.map((item, index) => (
                <pre className={item.level} key={`${item.level}:${item.message}:${index}`}><b>{item.level}</b>{item.count > 1 ? <em>×{item.count}</em> : null}<span>{item.message}</span></pre>
              ))}
            </div>
          </details>
        ) : null}

        {showProcessOutput && mergedOutput ? (
          <section className="runtime-process-output">
            <strong>Process output</strong>
            <pre>{mergedOutput}</pre>
          </section>
        ) : null}

        <section className="runtime-analysis-log">
          <strong>Analysis / build log</strong>
          {buildEntries.length ? buildEntries.slice(-80).map((entry, index) => (
            <pre className={entry.level} key={`${entry.time}:${index}`}><time>{new Date(entry.time).toLocaleTimeString()}</time><span>{entry.message}</span></pre>
          )) : <p>No diagnostics have been emitted in this session.</p>}
        </section>
      </div>
    </div>
  );
}
