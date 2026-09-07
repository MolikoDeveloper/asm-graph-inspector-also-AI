import { useEffect, useMemo, useRef, useState } from 'react';
import { FastForward, Pause, Play, RotateCcw, Send, StepForward } from 'lucide-react';
import type { BlinkIsaPreflightState } from '../features/execution/blinkIsaPreflight';
import type { ExecutionSnapshot, ExecutionSupport } from '../features/execution/model';
import { submitActiveExecutionInput } from '../features/execution/activeInput';
import { deriveAssemblyBuildTelemetry, type DebugLogEntryLike } from '../features/execution/debugTelemetry';
import { renderVirtualTerminal } from '../features/execution/virtualTerminal';
import './ExecutionConsole.css';

function hex(value: bigint | null | undefined): string {
  return value === null || value === undefined ? '—' : `0x${value.toString(16).padStart(16, '0')}`;
}

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(3)} s`;
}

function byteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function bytesHex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

const REGISTER_ROWS = [
  ['rax', 'rbx', 'rcx', 'rdx'],
  ['rsi', 'rdi', 'rbp', 'rsp'],
  ['r8', 'r9', 'r10', 'r11'],
  ['r12', 'r13', 'r14', 'r15']
] as const;

export function ExecutionConsole({
  snapshot,
  preflight,
  support,
  targetName,
  buildEntries,
  onPrepare,
  onRun,
  onProbe,
  onPause,
  onStep,
  onReset
}: {
  snapshot: ExecutionSnapshot;
  preflight: BlinkIsaPreflightState;
  support: ExecutionSupport | null;
  targetName: string | null;
  buildEntries: readonly DebugLogEntryLike[];
  onPrepare(): void;
  onRun(): void;
  onProbe(): void;
  onPause(): void;
  onStep(): void;
  onReset(): void;
}) {
  const supported = support?.supported === true;
  const running = snapshot.status === 'running';
  const terminal = snapshot.status === 'exited' || snapshot.status === 'halted' || snapshot.status === 'trapped';
  const registers = snapshot.registers;
  const crash = snapshot.crash ?? null;
  const [autoStepping, setAutoStepping] = useState(false);
  const [autoDelay, setAutoDelay] = useState(50);
  const [lastStepMs, setLastStepMs] = useState<number | null>(null);
  const [runElapsedMs, setRunElapsedMs] = useState<number | null>(null);
  const [clock, setClock] = useState(0);
  const [cliInput, setCliInput] = useState('');
  const [cliLines, setCliLines] = useState<string[]>([]);
  const [stdoutOffset, setStdoutOffset] = useState(0);
  const stepStartedAt = useRef<number | null>(null);
  const stepInFlight = useRef(false);
  const previousStepKey = useRef('');
  const runRequested = useRef(false);
  const runCommandStartedAt = useRef<number | null>(null);
  const runStartedAt = useRef<number | null>(null);

  const buildTelemetry = useMemo(() => deriveAssemblyBuildTelemetry(buildEntries, Date.now()), [buildEntries, clock]);
  const renderedStdout = useMemo(() => {
    const offset = Math.min(stdoutOffset, snapshot.stdout.length);
    const raw = snapshot.stdout.slice(offset);
    const terminalText = renderVirtualTerminal(raw, { columns: 96, rows: 32 });
    return [terminalText, ...cliLines].filter(Boolean).join('\n');
  }, [cliLines, snapshot.stdout, stdoutOffset]);
  const preflightPercent = preflight.totalBytes > 0
    ? Math.min(100, Math.max(0, (preflight.processedBytes / preflight.totalBytes) * 100))
    : preflight.status === 'compatible' || preflight.status === 'incompatible' ? 100 : 0;
  const preflightLabel = preflight.status === 'idle'
    ? 'idle'
    : `${preflight.status}${preflight.elapsedMs !== null ? ` · ${duration(preflight.elapsedMs)}` : ''}`;

  useEffect(() => {
    if (buildTelemetry.status !== 'building' && !running && !autoStepping && preflight.status !== 'scanning') return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 80);
    return () => window.clearInterval(timer);
  }, [autoStepping, buildTelemetry.status, preflight.status, running]);

  useEffect(() => {
    const key = `${snapshot.targetFileId ?? 'none'}:${snapshot.instructionCount}:${snapshot.status}`;
    if (previousStepKey.current === key) return;
    previousStepKey.current = key;
    stepInFlight.current = false;
    if (stepStartedAt.current !== null && snapshot.instructionCount > 0) {
      setLastStepMs(Math.max(0, performance.now() - stepStartedAt.current));
      stepStartedAt.current = null;
    }
  }, [snapshot.instructionCount, snapshot.status, snapshot.targetFileId]);

  useEffect(() => {
    if (runRequested.current && runStartedAt.current === null && snapshot.status === 'running') {
      runStartedAt.current = performance.now();
    }
    if (!runRequested.current || !terminal) return;
    const now = performance.now();
    if (runStartedAt.current !== null) {
      setRunElapsedMs(Math.max(0, now - runStartedAt.current));
    } else if (runCommandStartedAt.current !== null) {
      const buildMs = buildTelemetry.status === 'idle' || buildTelemetry.status === 'building' ? 0 : (buildTelemetry.elapsedMs ?? 0);
      setRunElapsedMs(Math.max(0, now - runCommandStartedAt.current - buildMs));
    }
    runRequested.current = false;
    runCommandStartedAt.current = null;
    runStartedAt.current = null;
  }, [buildTelemetry.elapsedMs, buildTelemetry.status, snapshot.status, terminal]);

  useEffect(() => {
    if (!autoStepping) return;
    if (!supported || terminal || running) {
      setAutoStepping(false);
      stepInFlight.current = false;
      return;
    }
    if (stepInFlight.current) return;
    const timer = window.setTimeout(() => {
      stepInFlight.current = true;
      stepStartedAt.current = performance.now();
      onStep();
    }, autoDelay);
    return () => window.clearTimeout(timer);
  }, [autoDelay, autoStepping, onStep, running, snapshot.instructionCount, snapshot.status, snapshot.targetFileId, supported, terminal]);

  useEffect(() => {
    setAutoStepping(false);
    stepInFlight.current = false;
    setStdoutOffset(0);
    setCliLines([]);
  }, [snapshot.targetFileId]);

  function performStep() {
    if (stepInFlight.current) return;
    setAutoStepping(false);
    stepInFlight.current = true;
    stepStartedAt.current = performance.now();
    onStep();
  }

  function beginTimedRun(action: () => void) {
    setAutoStepping(false);
    stepInFlight.current = false;
    runRequested.current = true;
    runCommandStartedAt.current = performance.now();
    runStartedAt.current = null;
    setRunElapsedMs(null);
    action();
  }

  function performRun() {
    beginTimedRun(onRun);
  }

  function performProbe() {
    beginTimedRun(onProbe);
  }

  function performPause() {
    setAutoStepping(false);
    stepInFlight.current = false;
    if (runStartedAt.current !== null) {
      setRunElapsedMs(Math.max(0, performance.now() - runStartedAt.current));
      runRequested.current = false;
      runStartedAt.current = null;
      runCommandStartedAt.current = null;
    }
    onPause();
  }

  function performReset() {
    setAutoStepping(false);
    stepInFlight.current = false;
    runRequested.current = false;
    runStartedAt.current = null;
    runCommandStartedAt.current = null;
    setLastStepMs(null);
    setRunElapsedMs(null);
    onReset();
  }

  function addCliLine(text: string) {
    setCliLines((lines) => [...lines.slice(-31), text]);
  }

  function sendGuestInput(text: string) {
    const accepted = submitActiveExecutionInput(`${text}\n`);
    if (!accepted) {
      addCliLine('[inspector] no active stdin queue; Prepare/Run the program first.');
      return;
    }
    addCliLine(`[stdin] ${text}`);
    if (snapshot.status === 'paused' && snapshot.trapReason?.toLowerCase().includes('waiting for stdin')) {
      queueMicrotask(performRun);
    }
  }

  function executeCli(raw: string) {
    const command = raw.trim();
    if (!command) return;
    if (!command.startsWith(':')) {
      sendGuestInput(raw);
      return;
    }

    const [verb, ...rest] = command.slice(1).split(/\s+/);
    const argument = rest.join(' ');
    switch (verb.toLowerCase()) {
      case 'help':
        addCliLine('[inspector] :run :probe :step :auto :stop :pause :reset :status :clear :stdin <text> · plain text -> guest stdin');
        break;
      case 'run': performRun(); break;
      case 'probe': performProbe(); break;
      case 'step': performStep(); break;
      case 'auto': setAutoStepping(true); break;
      case 'stop': setAutoStepping(false); stepInFlight.current = false; break;
      case 'pause': performPause(); break;
      case 'reset': performReset(); break;
      case 'status':
        addCliLine(`[inspector] ${snapshot.status} · ${snapshot.provider ?? 'no provider'} · ${snapshot.instructionCount.toLocaleString()} stepped instruction(s) · ISA preflight ${preflight.status}${crash ? ` · ${crash.signalName} @ ${hex(crash.runtimeAddress)}` : ''}`);
        break;
      case 'clear':
        setStdoutOffset(snapshot.stdout.length);
        setCliLines([]);
        break;
      case 'stdin': sendGuestInput(argument); break;
      default: addCliLine(`[inspector] unknown command :${verb}; use :help`); break;
    }
  }

  const liveRunElapsed = runStartedAt.current !== null && running ? performance.now() - runStartedAt.current : runElapsedMs;
  const buildLabel = buildTelemetry.status === 'idle'
    ? 'idle'
    : `${buildTelemetry.status}${buildTelemetry.elapsedMs !== null ? ` · ${duration(buildTelemetry.elapsedMs)}` : ''}`;

  return (
    <div className="execution-console">
      <div className="execution-toolbar">
        <div className="execution-target">
          <strong>{targetName ?? 'No executable or ASM source selected'}</strong>
          <span className={`execution-status ${snapshot.status}`}>{autoStepping ? 'auto-step' : snapshot.status}</span>
          {support?.provider ? <code>{snapshot.provider ?? support.provider}</code> : null}
          {snapshot.instructionCount ? <code>{snapshot.instructionCount.toLocaleString()} stepped insn</code> : null}
        </div>
        <div className="execution-actions">
          <button type="button" disabled={!supported || running} onClick={onPrepare} title="Prepare/reset execution session"><RotateCcw size={13} /> Prepare</button>
          <button type="button" disabled={!supported || running || terminal || autoStepping} onClick={performStep} title="Execute one machine instruction"><StepForward size={13} /> Step</button>
          <button type="button" className={autoStepping ? 'execution-auto-active' : ''} disabled={!supported || running || terminal} onClick={() => setAutoStepping((value) => !value)} title="Continuously Step while refreshing live disassembly and CFG"><FastForward size={13} /> {autoStepping ? 'Stop Auto' : 'Auto Step'}</button>
          <select className="execution-auto-speed" aria-label="Auto Step interval" value={autoDelay} disabled={running} onChange={(event) => setAutoDelay(Number(event.target.value))}>
            <option value={16}>16 ms</option><option value={50}>50 ms</option><option value={150}>150 ms</option><option value={500}>500 ms</option>
          </select>
          <button type="button" disabled={!supported || running || terminal || autoStepping} onClick={performRun} title="Run in bounded browser batches"><Play size={13} /> Run</button>
          {preflight.status === 'incompatible' ? <button type="button" className="execution-probe" disabled={!supported || running || autoStepping} onClick={performProbe} title="Explicitly run an ISA-incompatible ELF only to capture the observed Blink signal/RIP"><Play size={13} /> Probe failure</button> : null}
          <button type="button" disabled={!running && !autoStepping} onClick={performPause} title="Pause Run or stop Auto Step"><Pause size={13} /> Pause</button>
          <button type="button" disabled={!supported || running} onClick={performReset} title="Reload execution mappings and machine state"><RotateCcw size={13} /> Reset</button>
        </div>
      </div>

      {!support ? <div className="execution-empty">Open an ASM source file or an analyzed ELF64 x86-64 binary to create an execution session.</div> : null}
      {support && !support.supported ? (
        <div className="execution-unsupported">
          <strong>Execution refused</strong>
          {support.reasons.map((reason) => <span key={reason}>{reason}</span>)}
          <small>The analyzer can still inspect this image. Execution intentionally fails closed until the missing loader/provider semantics exist.</small>
        </div>
      ) : null}

      {supported ? (
        <div className="execution-body">
          {support.notes.length ? <div className="execution-provider-notes">{support.notes.map((note) => <span key={note}>{note}</span>)}</div> : null}
          {preflight.status !== 'idle' ? (
            <section className={`execution-preflight ${preflight.status}`}>
              <div className="execution-preflight-heading">
                <strong>Static Blink ISA preflight</strong>
                <code>{preflightLabel}</code>
              </div>
              <div className="execution-preflight-progress" aria-label={`Blink ISA preflight ${preflightPercent.toFixed(0)} percent`}>
                <span style={{ width: `${preflightPercent}%` }} />
              </div>
              <div className="execution-preflight-stats">
                <span>{preflight.scannedInstructions.toLocaleString()} decoded instructions</span>
                <span>{byteCount(preflight.processedBytes)} / {byteCount(preflight.totalBytes)} executable bytes</span>
                <span>{preflight.unsupportedFamilies.length ? `unsupported: ${preflight.unsupportedFamilies.join(', ')}` : 'no unsupported ISA evidence'}</span>
              </div>
              {preflight.evidence.length ? (
                <div className="execution-preflight-evidence">
                  {preflight.evidence.slice(0, 6).map((item, index) => (
                    <code key={`${item.address}:${item.mnemonic}:${index}`}>static · 0x{item.address.toString(16)} · {item.mnemonic}{item.operands ? ` ${item.operands}` : ''} · [{bytesHex(item.bytes)}] · {item.family}</code>
                  ))}
                </div>
              ) : null}
              {preflight.status === 'incompatible' ? <small className="execution-preflight-note">Static evidence proves the ELF contains unsupported executable instructions; it does not claim those instructions were reached. Use <b>Probe failure</b> only when you need the actually observed Blink signal/RIP.</small> : null}
              {preflight.message && preflight.status !== 'scanning' ? <p>{preflight.message}</p> : null}
            </section>
          ) : null}
          <section className="execution-state">
            <div className="execution-metrics">
              <span><b>ASM pipeline</b><code className={buildTelemetry.status}>{buildLabel}</code></span>
              <span><b>Blink ISA preflight</b><code className={`preflight-${preflight.status}`}>{preflightLabel}</code></span>
              <span><b>Binary execution</b><code>{duration(liveRunElapsed)}</code></span>
              <span><b>Last Step latency</b><code>{duration(lastStepMs)}</code></span>
            </div>
            <div className="execution-current">
              <span><b>RIP</b><code>{hex(registers?.rip)}</code></span>
              <span><b>RSP</b><code>{hex(registers?.rsp)}</code></span>
              <span><b>RFLAGS</b><code>{hex(registers?.rflags)}</code></span>
              <span><b>Last</b><code>{snapshot.lastInstruction ? `${snapshot.lastInstruction.mnemonic} ${snapshot.lastInstruction.operands}`.trim() : '—'}</code></span>
            </div>
            {registers ? <div className="execution-registers">{REGISTER_ROWS.flat().map((name) => <span key={name}><b>{name.toUpperCase()}</b><code>{hex(registers[name])}</code></span>)}</div> : <div className="execution-empty compact">{snapshot.provider === 'blink-process' ? 'Blink register state appears after the first headless signal/preemption or after Step initialization.' : 'Prepare the session to initialize registers and mappings.'}</div>}
            {crash ? (
              <section className="execution-crash">
                <div className="execution-crash-heading"><strong>Observed runtime failure</strong><code>{crash.signalName} · signal {crash.signal} · code {crash.signalCode} · exit {crash.exitCode}</code></div>
                <div className="execution-crash-grid">
                  <span><b>Runtime RIP</b><code>{hex(crash.runtimeAddress)}</code></span>
                  <span><b>Image</b><code>{crash.imageName ?? 'unresolved'}{crash.imageRole ? ` · ${crash.imageRole}` : ''}</code></span>
                  <span><b>ELF address</b><code>{hex(crash.imageAddress)}</code></span>
                  <span><b>Load bias</b><code>{hex(crash.loadBias)}</code></span>
                  <span><b>Function</b><code>{crash.functionName ? `${crash.functionName}${crash.functionOffset ? `+0x${crash.functionOffset.toString(16)}` : ''}` : 'unresolved'}</code></span>
                  <span><b>ISA evidence</b><code>{crash.isaFamily ?? 'none from decoded faulting instruction'}</code></span>
                </div>
                {crash.instruction ? <pre><b>instruction</b> 0x{crash.instruction.address.toString(16)}  {crash.instruction.mnemonic}{crash.instruction.operands ? ` ${crash.instruction.operands}` : ''}\n<b>bytes</b>       {bytesHex(crash.instruction.bytes)}</pre> : crash.codeBytes.length ? <pre><b>bytes @ RIP</b> {bytesHex(crash.codeBytes)}</pre> : null}
                <small>This block is observed runtime evidence captured at Blink's fatal-signal boundary. Unlike the static ISA preflight, this RIP was reached by this execution.</small>
              </section>
            ) : null}
            {snapshot.providerDiagnostics.length ? (
              <details className="execution-provider-diagnostics" open={terminal}>
                <summary>Provider diagnostics · {snapshot.providerDiagnostics.reduce((total, item) => total + item.count, 0)} event(s)</summary>
                <div>
                  {snapshot.providerDiagnostics.map((item, index) => (
                    <pre className={item.level} key={`${item.level}:${item.message}:${index}`}><b>{item.level}</b>{item.count > 1 ? <em>×{item.count}</em> : null}<span>{item.message}</span></pre>
                  ))}
                </div>
              </details>
            ) : null}
            {!crash && snapshot.trapReason ? <div className="execution-trap"><strong>Trap</strong><span>{snapshot.trapReason}</span></div> : null}
            {snapshot.exitCode !== null ? <div className="execution-exit">Process exited with code <code>{snapshot.exitCode}</code>.</div> : null}
          </section>

          <section className="execution-io virtualized">
            <div className="virtual-terminal">
              <header><span>Virtual TTY / stdout</span><span>plain text = stdin · :help = inspector CLI</span></header>
              <pre>{renderedStdout || ' '}</pre>
              <form className="virtual-cli-form" onSubmit={(event) => { event.preventDefault(); const value = cliInput; setCliInput(''); executeCli(value); }}>
                <code>$</code>
                <input value={cliInput} onChange={(event) => setCliInput(event.target.value)} placeholder="stdin text or :help" spellCheck={false} />
                <button type="submit" title="Send to virtual CLI"><Send size={12} /> Send</button>
              </form>
            </div>
            <div className="execution-stream stderr"><header>stderr</header><pre>{snapshot.stderr || ' '}</pre></div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
