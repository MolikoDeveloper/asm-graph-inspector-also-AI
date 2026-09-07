import { useState } from 'react';
import { AlertCircle, Bug, TerminalSquare } from 'lucide-react';
import type { AssemblyProblem } from '../features/analysis/asmParser';
import { useBlinkIsaPreflightMonitor } from '../features/execution/blinkIsaPreflightMonitor';
import type { ExecutionSnapshot, ExecutionSupport } from '../features/execution/model';
import { InspectorTerminal, type InspectorTerminalCommandResult } from './InspectorTerminal';
import { RuntimeDiagnostics } from './RuntimeDiagnostics';
import './BottomPanel.css';

export interface OutputEntry {
  id: string;
  time: number;
  level: 'info' | 'success' | 'error' | 'muted';
  message: string;
}

type BottomPanelTab = 'terminal' | 'diagnostics' | 'problems';

export function BottomPanel({
  entries,
  problems,
  onSelectProblem,
  execution,
  executionSupport,
  executionTargetName,
  runtimeOutputChannel,
  onTerminalCommand
}: {
  entries: OutputEntry[];
  problems: AssemblyProblem[];
  onSelectProblem(problem: AssemblyProblem): void;
  execution: ExecutionSnapshot;
  executionSupport: ExecutionSupport | null;
  executionTargetName: string | null;
  runtimeOutputChannel: 'terminal' | 'diagnostics';
  onTerminalCommand(command: string): Promise<InspectorTerminalCommandResult | void>;
}) {
  const [tab, setTab] = useState<BottomPanelTab>('terminal');
  const executionPreflight = useBlinkIsaPreflightMonitor();
  const errorCount = problems.filter((problem) => problem.severity === 'error').length;
  const diagnosticCount = execution.providerDiagnostics.reduce((total, item) => total + item.count, 0)
    + (execution.crash ? 1 : 0)
    + (executionPreflight.status === 'incompatible' || executionPreflight.status === 'error' ? 1 : 0);

  return (
    <section className="bottom-panel bottom-panel-console">
      <div className="bottom-tabs">
        <button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}><TerminalSquare size={14} /> Terminal / Console</button>
        <button className={tab === 'diagnostics' ? 'active' : ''} onClick={() => setTab('diagnostics')}><Bug size={13} /> Diagnostics{diagnosticCount ? <span className="bottom-tab-badge">{diagnosticCount}</span> : null}</button>
        <button className={tab === 'problems' ? 'active' : ''} onClick={() => setTab('problems')}><AlertCircle size={13} /> Problems{problems.length ? <span className="bottom-tab-badge">{problems.length}</span> : null}</button>
      </div>

      <div className={`bottom-panel-page ${tab === 'terminal' ? 'active' : ''}`} aria-hidden={tab !== 'terminal'}>
        <InspectorTerminal
          snapshot={execution}
          captureRuntimeOutput={runtimeOutputChannel === 'terminal'}
          onCommand={onTerminalCommand}
        />
      </div>

      <div className={`bottom-panel-page ${tab === 'diagnostics' ? 'active' : ''}`} aria-hidden={tab !== 'diagnostics'}>
        <RuntimeDiagnostics
          snapshot={execution}
          preflight={executionPreflight}
          support={executionSupport}
          targetName={executionTargetName}
          buildEntries={entries}
          showProcessOutput={runtimeOutputChannel === 'diagnostics'}
        />
      </div>

      <div className={`bottom-panel-page ${tab === 'problems' ? 'active' : ''}`} aria-hidden={tab !== 'problems'}>
        <div className="problems-list">
          {problems.length ? problems.map((problem) => (
            <button key={problem.id} onClick={() => onSelectProblem(problem)}>
              <AlertCircle size={13} />
              <span className={`problem-severity ${problem.severity}`}>{problem.severity}</span>
              <span className="problem-message">{problem.message}</span>
              <code>Ln {problem.line}:{problem.column}</code>
            </button>
          )) : <div className="problems-empty">No problems in the active file.</div>}
        </div>
      </div>

      {errorCount > 0 && tab !== 'problems' ? <span className="bottom-panel-error-indicator" title={`${errorCount} active error${errorCount === 1 ? '' : 's'}`} /> : null}
    </section>
  );
}
