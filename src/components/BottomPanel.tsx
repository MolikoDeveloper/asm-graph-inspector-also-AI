import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, TerminalSquare } from 'lucide-react';
import type { AssemblyProblem } from '../features/analysis/asmParser';

export interface OutputEntry {
  id: string;
  time: number;
  level: 'info' | 'success' | 'error' | 'muted';
  message: string;
}

export function BottomPanel({ entries, problems, onSelectProblem }: {
  entries: OutputEntry[];
  problems: AssemblyProblem[];
  onSelectProblem(problem: AssemblyProblem): void;
}) {
  const [tab, setTab] = useState<'output' | 'problems' | 'debug'>('output');
  const errorCount = problems.filter((problem) => problem.severity === 'error').length;
  useEffect(() => {
    if (errorCount > 0) setTab('problems');
  }, [errorCount]);

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
      {tab === 'debug' ? <div className="debug-console-placeholder">Execution/debug provider is not connected yet. This panel is reserved for observed runtime events.</div> : null}
    </section>
  );
}
