import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Trash2 } from 'lucide-react';
import { submitActiveExecutionInput } from '../features/execution/activeInput';
import type { ExecutionSnapshot } from '../features/execution/model';
import { renderVirtualTerminal } from '../features/execution/virtualTerminal';
import './InspectorTerminal.css';

export type InspectorTerminalLineLevel = 'command' | 'info' | 'success' | 'error' | 'output' | 'muted';

export interface InspectorTerminalLine {
  level: InspectorTerminalLineLevel;
  text: string;
}

export interface InspectorTerminalCommandResult {
  clear?: boolean;
  lines?: InspectorTerminalLine[];
}

function waitingForGuestInput(snapshot: ExecutionSnapshot): boolean {
  if (snapshot.status !== 'paused') return false;
  return snapshot.trapReason?.toLowerCase().includes('stdin') === true;
}

function terminalStatusLine(snapshot: ExecutionSnapshot): InspectorTerminalLine | null {
  if (snapshot.status === 'exited') {
    return { level: snapshot.exitCode === 0 || snapshot.exitCode === null ? 'success' : 'muted', text: `Process exited with code ${snapshot.exitCode ?? 0}.` };
  }
  if (snapshot.status === 'trapped') {
    const crash = snapshot.crash;
    if (crash) {
      const address = crash.runtimeAddress !== null ? ` at 0x${crash.runtimeAddress.toString(16)}` : '';
      return { level: 'error', text: `${crash.signalName}${address} · exit ${crash.exitCode}.` };
    }
    return { level: 'error', text: snapshot.trapReason ?? 'Process trapped.' };
  }
  if (snapshot.status === 'halted') return { level: 'muted', text: snapshot.trapReason ?? 'Process halted.' };
  return null;
}

export function InspectorTerminal({
  snapshot,
  captureRuntimeOutput,
  onCommand
}: {
  snapshot: ExecutionSnapshot;
  captureRuntimeOutput: boolean;
  onCommand(command: string): Promise<InspectorTerminalCommandResult | void>;
}) {
  const [input, setInput] = useState('');
  const [lines, setLines] = useState<InspectorTerminalLine[]>([]);
  const stdoutOffset = useRef(0);
  const stderrOffset = useRef(0);
  const runtimeTarget = useRef<string | null>(null);
  const terminalFingerprint = useRef('');
  const viewportRef = useRef<HTMLDivElement>(null);

  function append(next: InspectorTerminalLine | InspectorTerminalLine[]) {
    const additions = Array.isArray(next) ? next : [next];
    if (!additions.length) return;
    setLines((current) => [...current, ...additions].slice(-500));
  }

  function clear() {
    setLines([]);
    stdoutOffset.current = snapshot.stdout.length;
    stderrOffset.current = snapshot.stderr.length;
    terminalFingerprint.current = '';
  }

  useEffect(() => {
    if (runtimeTarget.current === snapshot.targetFileId) return;
    runtimeTarget.current = snapshot.targetFileId;
    stdoutOffset.current = 0;
    stderrOffset.current = 0;
    terminalFingerprint.current = '';
  }, [snapshot.targetFileId]);

  useEffect(() => {
    if (!captureRuntimeOutput) return;
    const stdoutStart = Math.min(stdoutOffset.current, snapshot.stdout.length);
    const stderrStart = Math.min(stderrOffset.current, snapshot.stderr.length);
    const stdoutChunk = snapshot.stdout.slice(stdoutStart);
    const stderrChunk = snapshot.stderr.slice(stderrStart);
    stdoutOffset.current = snapshot.stdout.length;
    stderrOffset.current = snapshot.stderr.length;

    if (stdoutChunk) {
      const rendered = renderVirtualTerminal(stdoutChunk, { columns: 120, rows: 64 });
      if (rendered) append({ level: 'output', text: rendered });
    }
    if (stderrChunk) {
      const rendered = renderVirtualTerminal(stderrChunk, { columns: 120, rows: 64 });
      if (rendered) append({ level: 'output', text: rendered });
    }
  }, [captureRuntimeOutput, snapshot.stderr, snapshot.stdout]);

  useEffect(() => {
    if (!captureRuntimeOutput) return;
    const statusLine = terminalStatusLine(snapshot);
    if (!statusLine) return;
    const fingerprint = `${snapshot.targetFileId ?? 'none'}:${snapshot.status}:${snapshot.exitCode ?? 'none'}:${snapshot.instructionCount}:${snapshot.trapReason ?? ''}`;
    if (terminalFingerprint.current === fingerprint) return;
    terminalFingerprint.current = fingerprint;
    append(statusLine);
  }, [captureRuntimeOutput, snapshot.exitCode, snapshot.instructionCount, snapshot.status, snapshot.targetFileId, snapshot.trapReason, snapshot.crash]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [lines]);

  async function submit(raw: string) {
    const command = raw.trim();
    if (!command) return;
    setInput('');
    append({ level: 'command', text: `> ${raw}` });

    if (waitingForGuestInput(snapshot) && !/^(help|clear|open|analyze|run|stdin|status)\b/i.test(command)) {
      const accepted = submitActiveExecutionInput(`${raw}\n`);
      append(accepted
        ? { level: 'muted', text: `stdin ← ${raw}` }
        : { level: 'error', text: 'No guest process is accepting stdin.' });
      return;
    }

    if (/^stdin(?:\s|$)/i.test(command)) {
      const text = command.replace(/^stdin\s*/i, '');
      const accepted = submitActiveExecutionInput(`${text}\n`);
      append(accepted
        ? { level: 'muted', text: `stdin ← ${text}` }
        : { level: 'error', text: 'No guest process is accepting stdin.' });
      return;
    }

    try {
      const result = await onCommand(command);
      if (result?.clear) {
        clear();
        return;
      }
      if (result?.lines?.length) append(result.lines);
    } catch (error: unknown) {
      append({ level: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className="inspector-terminal">
      <div className="inspector-terminal-toolbar">
        <span>Virtual inspector console</span>
        <span className="inspector-terminal-hint">ELF / objdump analysis · direct project paths · guest stdin</span>
        <button type="button" onClick={clear} title="Clear terminal"><Trash2 size={12} /> Clear</button>
      </div>
      <div className="inspector-terminal-output" ref={viewportRef} role="log" aria-live="polite">
        {lines.length ? lines.map((line, index) => (
          <pre className={`inspector-terminal-line ${line.level}`} key={`${index}:${line.text.slice(0, 24)}`}>{line.text}</pre>
        )) : <pre className="inspector-terminal-line muted">Type <b>help</b> for inspector commands, or enter a project ELF path such as <b>build/ray_test</b> to execute it.</pre>}
      </div>
      <form className="inspector-terminal-input" onSubmit={(event) => { event.preventDefault(); void submit(input); }}>
        <code>&gt;</code>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={waitingForGuestInput(snapshot) ? 'guest stdin…' : 'command or project ELF path…'}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" title="Submit"><CornerDownLeft size={12} /></button>
      </form>
    </div>
  );
}
