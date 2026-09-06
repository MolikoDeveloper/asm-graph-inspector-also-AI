import { AlertCircle, CheckCircle2, TerminalSquare } from 'lucide-react';

export interface OutputEntry {
  id: string;
  time: number;
  level: 'info' | 'success' | 'error' | 'muted';
  message: string;
}

export function BottomPanel({ entries }: { entries: OutputEntry[] }) {
  return (
    <section className="bottom-panel">
      <div className="bottom-tabs"><button className="active"><TerminalSquare size={14} /> Output</button><button>Problems</button><button>Debug Console</button></div>
      <div className="output-log">
        {entries.length === 0 ? <div className="output-line muted">ASM Graph Inspector ready.</div> : entries.map((entry) => (
          <div className={`output-line ${entry.level}`} key={entry.id}>
            <span className="output-time">{new Date(entry.time).toLocaleTimeString()}</span>
            {entry.level === 'success' ? <CheckCircle2 size={13} /> : entry.level === 'error' ? <AlertCircle size={13} /> : <span className="output-dot">›</span>}
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
