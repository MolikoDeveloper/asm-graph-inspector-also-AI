import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, TerminalSquare } from 'lucide-react';
import type { AssemblyProblem } from '../features/analysis/asmParser';
import type { BlinkIsaPreflightState } from '../features/execution/blinkIsaPreflight';
import type { ExecutionSnapshot, ExecutionSupport } from '../features/execution/model';
import { ExecutionConsole } from './ExecutionConsole';

export interface OutputEntry {
  id: string;
  time: number;
  level: 'info' | 'success' | 'error' | 'muted';
  message: string;
}

function buildStarted(message: string | undefined): boolean {
  return !!message && (message.startsWith('Preparing real ELF for ') || (message.startsWith('Assembling ') && message.includes('pinned NASM + GNU ld')));
}

export function BottomPanel({ entries, problems, onSelectProblem, execution, executionPreflight, executionSupport, executionTargetName, onExecutionPrepare, onExecutionRun, onExecutionPause, onExecutionStep, onExecutionReset }: {
  entries: OutputEntry[];
  problems: AssemblyProblem[];
  onSelectProblem(problem: AssemblyProblem): void;
  execution: ExecutionSnapshot;
  executionPreflight: BlinkIsaPreflightState;
  executionSupport: ExecutionSupport | null;
  executionTargetName: string | null;
  onExecutionPrepare(): void;
  onExecutionRun(): void;
  onExecutionPause(): void;
  onExecutionStep(): void;
  onExecutionReset(): void;
}) {
  const [tab, setTab] = useState<'output' | 'problems' | 'debug'>('output');
  const errorCount = problems.filter((problem) => problem.severity === 'error').length;
  useEffect(() => {
    if (errorCount > 0) setTab('problems');
  }, [errorCount]);
  useEffect(() => {
    if (execution.status !== 'idle') setTab('debug');
  }, [execution.status]);
  useEffect(() => {
    if (executionPreflight.status !== 'idle') setTab('debug');
  }, [executionPreflight.status]);
  useEffect(() => {
    if (buildStarted(entries.at(-1)?.message)) setTab('debug');
  }, [entries]);

  return (
    <section className="bottom-panel">
      <div className="bottom-tabs">
        <button className={tab === 'output' ? 'active' : ''} onClick={() => setTab('output')}><TerminalSquare size={14} /> Output</button>
        <button className={tab === 'problems' ? 'active' : ''} onClick={() => setTab('problems')}>Problems{problems.length ? <span className="bottom-tab-badge">{problems.length}</span> : null}</button>
        <button className={tab === 'debug' ? 'active' : ''} onClick={() => setTab('debug')}>Debug Console</button>
      </div>
      {tab === 'output' ? (
        <div className="output-log">
          {entries.length === 0 ? <div className="output-line muted">ASM Graph Inspector ready.</div> : entries.map((entry) => (
            <div className={`output-line ${entry.level}`} key={entry.id}>
              <span className="output-time">{new Date(entry.time).toLocaleTimeString()}</span>
              {entry.level === 'success' ? <CheckCircle2 size={13} /> : entry.level === 'error' ? <AlertCircle size={13} /> : <span className="output-dot">›</span>}
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      ) : null}
      {tab === 'problems' ? (
        <div className="problems-list">
          {problems.length ? problems.map((problem) => (
            <button key={problem.id} onClick={() => onSelectProblem(problem)}>
              <AlertCircle size={13} />
              <span className={`problem-severity ${problem.severity}`}>{problem.severity}</span>
              <span className="problem-message">{problem.message}</span>
              <code>Ln {problem.line}:{problem.column}</code>
            </button>
          )) : <div className="problems-empty"><CheckCircle2 size={14} /> No problems in the active file.</div>}
        </div>
      ) : null}
      {tab === 'debug' ? <ExecutionConsole snapshot={execution} preflight={executionPreflight} support={executionSupport} targetName={executionTargetName} buildEntries={entries} onPrepare={onExecutionPrepare} onRun={onExecutionRun} onPause={onExecutionPause} onStep={onExecutionStep} onReset={onExecutionReset} /> : null}
    </section>
  );
}
