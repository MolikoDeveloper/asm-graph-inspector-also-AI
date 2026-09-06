import { Pause, Play, RotateCcw, StepForward } from 'lucide-react';
import type { ExecutionSnapshot, ExecutionSupport } from '../features/execution/model';

function hex(value: bigint | null | undefined): string {
  return value === null || value === undefined ? '—' : `0x${value.toString(16).padStart(16, '0')}`;
}

const REGISTER_ROWS = [
  ['rax', 'rbx', 'rcx', 'rdx'],
  ['rsi', 'rdi', 'rbp', 'rsp'],
  ['r8', 'r9', 'r10', 'r11'],
  ['r12', 'r13', 'r14', 'r15']
] as const;

export function ExecutionConsole({
  snapshot,
  support,
  targetName,
  onPrepare,
  onRun,
  onPause,
  onStep,
  onReset
}: {
  snapshot: ExecutionSnapshot;
  support: ExecutionSupport | null;
  targetName: string | null;
  onPrepare(): void;
  onRun(): void;
  onPause(): void;
  onStep(): void;
  onReset(): void;
}) {
  const supported = support?.supported === true;
  const running = snapshot.status === 'running';
  const terminal = snapshot.status === 'exited' || snapshot.status === 'halted' || snapshot.status === 'trapped';
  const registers = snapshot.registers;

  return (
    <div className="execution-console">
      <div className="execution-toolbar">
        <div className="execution-target">
          <strong>{targetName ?? 'No executable selected'}</strong>
          <span className={`execution-status ${snapshot.status}`}>{snapshot.status}</span>
          {support?.provider ? <code>{snapshot.provider ?? support.provider}</code> : null}
          {snapshot.instructionCount ? <code>{snapshot.instructionCount.toLocaleString()} stepped insn</code> : null}
        </div>
        <div className="execution-actions">
          <button type="button" disabled={!supported || running} onClick={onPrepare} title="Prepare/reset execution session"><RotateCcw size={13} /> Prepare</button>
          <button type="button" disabled={!supported || running || terminal} onClick={onStep} title="Execute one machine instruction"><StepForward size={13} /> Step</button>
          <button type="button" disabled={!supported || running || terminal} onClick={onRun} title="Run in bounded browser batches"><Play size={13} /> Run</button>
          <button type="button" disabled={!running} onClick={onPause} title="Pause after the current execution batch"><Pause size={13} /> Pause</button>
          <button type="button" disabled={!supported || running} onClick={onReset} title="Reload ELF mappings and process state"><RotateCcw size={13} /> Reset</button>
        </div>
      </div>

      {!support ? <div className="execution-empty">Open an analyzed ELF64 x86-64 binary to create an execution session.</div> : null}
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
          <section className="execution-state">
            <div className="execution-current">
              <span><b>RIP</b><code>{hex(registers?.rip)}</code></span>
              <span><b>RSP</b><code>{hex(registers?.rsp)}</code></span>
              <span><b>RFLAGS</b><code>{hex(registers?.rflags)}</code></span>
              <span><b>Last</b><code>{snapshot.lastInstruction ? `${snapshot.lastInstruction.mnemonic} ${snapshot.lastInstruction.operands}`.trim() : '—'}</code></span>
            </div>
            {registers ? <div className="execution-registers">{REGISTER_ROWS.flat().map((name) => <span key={name}><b>{name.toUpperCase()}</b><code>{hex(registers[name])}</code></span>)}</div> : <div className="execution-empty compact">{snapshot.provider === 'blink-process' ? 'Process Run uses Blink headless compatibility mode; register snapshots are available after Reset + Step.' : 'Prepare the session to initialize registers and mappings.'}</div>}
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
            {snapshot.trapReason ? <div className="execution-trap"><strong>Trap</strong><span>{snapshot.trapReason}</span></div> : null}
            {snapshot.exitCode !== null ? <div className="execution-exit">Process exited with code <code>{snapshot.exitCode}</code>.</div> : null}
          </section>

          <section className="execution-io">
            <div className="execution-stream"><header>stdout</header><pre>{snapshot.stdout || ' '}</pre></div>
            <div className="execution-stream stderr"><header>stderr</header><pre>{snapshot.stderr || ' '}</pre></div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
