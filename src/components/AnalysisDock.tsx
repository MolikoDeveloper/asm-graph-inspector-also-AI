import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Binary, Boxes, Braces, GitBranch, GitFork, Grid2X2, MemoryStick } from 'lucide-react';
import type { AnalysisGraph } from '../features/analysis/model';
import { analyzeDataflow, projectDataflow, type DataflowProjection } from '../features/analysis/dataflow';
import { buildProgramFlow, type ProgramFlowScope } from '../features/analysis/programFlow';
import type { BinaryAnalysisSummary } from '../features/binary/model';
import { BinaryModelView, type BinaryModelViewKind } from './BinaryModelView';
import { FunctionTree } from './FunctionTree';
import { GraphPanel } from './GraphPanel';
import { InspectorPanel } from './InspectorPanel';
import { ProgramFlowToolbar } from './ProgramFlowToolbar';
import { ResizeHandle } from './ResizeHandle';

type AnalysisTab = 'cfg' | 'dataflow' | 'disassembly';
type DisassemblyView = 'functions' | BinaryModelViewKind;
type CfgView = 'program' | 'function';

const BINARY_TABS: Array<{ id: AnalysisTab; label: string; icon: typeof GitBranch }> = [
  { id: 'cfg', label: 'CFG', icon: GitBranch },
  { id: 'dataflow', label: 'Dataflow', icon: GitFork },
  { id: 'disassembly', label: 'Disassembly', icon: Binary }
];

const SOURCE_TABS: Array<{ id: AnalysisTab; label: string; icon: typeof GitBranch }> = [
  { id: 'cfg', label: 'Graph', icon: GitBranch },
  { id: 'dataflow', label: 'Dataflow', icon: GitFork }
];

const DISASSEMBLY_VIEWS: Array<{ id: DisassemblyView; label: string; icon: typeof GitBranch }> = [
  { id: 'functions', label: 'Functions', icon: GitBranch },
  { id: 'map', label: 'Map', icon: Grid2X2 },
  { id: 'sections', label: 'Sections', icon: Boxes },
  { id: 'symbols', label: 'Symbols', icon: Braces },
  { id: 'relocs', label: 'Relocs', icon: GitFork },
  { id: 'unwind', label: 'Unwind', icon: MemoryStick }
];

const DATAFLOW_PROJECTIONS: Array<{ id: DataflowProjection; label: string }> = [
  { id: 'flow', label: 'Flow' },
  { id: 'registers', label: 'Registers' },
  { id: 'memory', label: 'Memory' },
  { id: 'calls', label: 'Calls / syscalls' },
  { id: 'raw', label: 'Raw SSA' }
];

export function AnalysisDock({
  graph,
  binarySummary,
  grid,
  labels,
  selectedId,
  onSelect,
  onClearGraph,
  analysisStale = false,
  onNavigate,
  onSelectFunction
}: {
  graph: AnalysisGraph | null;
  binarySummary: BinaryAnalysisSummary | null;
  grid: boolean;
  labels: boolean;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onClearGraph(): void;
  analysisStale?: boolean;
  onNavigate(node: { line?: number; address?: number }): void;
  onSelectFunction(address: number): void;
}) {
  const [tab, setTab] = useState<AnalysisTab>('cfg');
  const [projection, setProjection] = useState<DataflowProjection>('flow');
  const [disassemblyView, setDisassemblyView] = useState<DisassemblyView>('functions');
  const [cfgView, setCfgView] = useState<CfgView>('program');
  const [programScope, setProgramScope] = useState<ProgramFlowScope>('visited');
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [summaryHistory, setSummaryHistory] = useState<Map<number, BinaryAnalysisSummary>>(() => new Map());
  const [inspectorWidth, setInspectorWidth] = useState(250);
  const binaryFileId = binarySummary?.image.sourceFileId ?? null;

  useEffect(() => {
    if (!binarySummary && tab === 'disassembly') setTab('cfg');
  }, [binarySummary, tab]);

  useEffect(() => {
    setSummaryHistory(new Map());
    setHiddenGroups(new Set());
    setExpandedGroups(new Set());
    setProgramScope('visited');
  }, [binaryFileId]);

  useEffect(() => {
    if (!binarySummary) return;
    setSummaryHistory((current) => {
      const next = new Map(current);
      next.set(binarySummary.rootAddress, binarySummary);
      return next;
    });
  }, [binarySummary]);

  const functions = useMemo(() => binarySummary ? [...binarySummary.functions].sort((a, b) => a.address - b.address) : [], [binarySummary]);
  const dataflow = useMemo(() => graph ? analyzeDataflow(graph, binarySummary) : null, [graph, binarySummary]);
  const dataflowGraph = useMemo(() => dataflow ? projectDataflow(dataflow, projection) : null, [dataflow, projection]);
  const programFlow = useMemo(() => {
    if (!binarySummary) return null;
    const history = new Map(summaryHistory);
    history.set(binarySummary.rootAddress, binarySummary);
    return buildProgramFlow({
      fileId: binarySummary.image.sourceFileId,
      functions: binarySummary.functions,
      pltStubs: binarySummary.pltStubs,
      summaries: [...history.values()],
      activeAddress: binarySummary.rootAddress,
      scope: programScope,
      hiddenGroups,
      expandedGroups
    });
  }, [binarySummary, summaryHistory, programScope, hiddenGroups, expandedGroups]);
  const cfgGraph = binarySummary && cfgView === 'program' ? programFlow?.graph ?? graph : graph;
  const graphForInspector = tab === 'dataflow' ? dataflowGraph : tab === 'cfg' ? cfgGraph : graph;
  const tabs = binarySummary ? BINARY_TABS : SOURCE_TABS;

  useEffect(() => {
    if (tab === 'disassembly') return;
    if (!selectedId || !graphForInspector) return;
    if (graphForInspector.nodes.some((node) => node.id === selectedId)) return;
    onSelect(graphForInspector.nodes[0]?.id ?? null);
  }, [graphForInspector, selectedId, onSelect, tab]);

  const navigateAddress = (address: number) => onNavigate({ address });
  const selectFunction = (address: number) => {
    onSelectFunction(address);
    navigateAddress(address);
  };

  const toggleExpandedGroup = (groupId: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const selectNode = (id: string | null) => {
    onSelect(id);
    if (!id || !graphForInspector) return;
    if (tab === 'cfg' && cfgView === 'program' && programFlow) {
      const action = programFlow.actions.get(id);
      if (action?.kind === 'function') {
        selectFunction(action.address);
        return;
      }
      if (action?.kind === 'group') {
        toggleExpandedGroup(action.groupId);
        return;
      }
      if (action?.kind === 'navigate') {
        navigateAddress(action.address);
        return;
      }
    }
    const node = graphForInspector.nodes.find((candidate) => candidate.id === id);
    if (node) onNavigate(node);
  };

  const graphColumns = {
    gridTemplateColumns: `minmax(180px, 1fr) 4px minmax(170px, min(${inspectorWidth}px, 38%))`
  };

  const toggleGroupVisibility = (groupId: string) => {
    setHiddenGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <section className="analysis-dock-shell">
      <header className="analysis-tabbar">
        <div className="analysis-tabstrip">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); onSelect(null); }}><Icon size={13} />{label}</button>)}
        </div>
        <div className="analysis-context-controls">
          {analysisStale ? <span className="analysis-stale-badge">Last valid snapshot</span> : null}
          {binarySummary && tab === 'cfg' ? (
            <label className="cfg-mode-picker">
              <GitBranch size={13} />
              <span>View</span>
              <select value={cfgView} onChange={(event) => { setCfgView(event.currentTarget.value as CfgView); onSelect(null); }}>
                <option value="program">Program flow</option>
                <option value="function">Function CFG</option>
              </select>
            </label>
          ) : null}
          {tab === 'dataflow' ? (
            <label className="dataflow-picker">
              <GitFork size={13} />
              <span>View</span>
              <select value={projection} onChange={(event: ChangeEvent<HTMLSelectElement>) => { setProjection(event.currentTarget.value as DataflowProjection); onSelect(null); }}>
                {DATAFLOW_PROJECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              {dataflow ? <small>{dataflow.values.length} values · {dataflow.phiValues.length} φ</small> : null}
            </label>
          ) : null}
          {binarySummary && tab !== 'disassembly' ? <label className="function-picker"><Binary size={13} /><span>Function</span><select value={binarySummary.rootAddress} onChange={(event: ChangeEvent<HTMLSelectElement>) => selectFunction(Number(event.currentTarget.value))}>{functions.map((fn) => <option key={`${fn.address}:${fn.name}`} value={fn.address}>{fn.name} · 0x{fn.address.toString(16)}</option>)}</select></label> : null}
        </div>
      </header>

      {tab === 'cfg' ? (
        <div className={`cfg-view-shell ${!binarySummary || cfgView === 'function' ? 'function-only' : ''}`}>
          {binarySummary && cfgView === 'program' && programFlow ? (
            <ProgramFlowToolbar
              groups={programFlow.groups}
              hiddenGroups={hiddenGroups}
              expandedGroups={expandedGroups}
              scope={programScope}
              visitedCount={programFlow.visitedCount}
              onScopeChange={setProgramScope}
              onToggleVisibility={toggleGroupVisibility}
              onShowAll={() => setHiddenGroups(new Set())}
              onHideAll={() => setHiddenGroups(new Set(programFlow.groups.map((group) => group.id)))}
              onCompactAll={() => setExpandedGroups(new Set())}
            />
          ) : null}
          <div className="analysis-dock analysis-dock-cfg" style={graphColumns}>
            <GraphPanel graph={cfgGraph} title={binarySummary && cfgView === 'program' ? `Program flow · ${programFlow?.visitedCount ?? 0} visited` : graph?.viewKind === 'function-cfg' ? 'Function CFG' : 'Flow graph'} grid={grid} labels={labels} selectedId={selectedId} onSelect={selectNode} onClear={onClearGraph} />
            <ResizeHandle orientation="vertical" onDelta={(delta) => setInspectorWidth((width) => Math.min(520, Math.max(190, width - delta)))} />
            <InspectorPanel graph={cfgGraph} selectedId={selectedId} stale={analysisStale} onNavigate={onNavigate} />
          </div>
        </div>
      ) : null}

      {tab === 'dataflow' ? (
        <div className="analysis-dock analysis-dock-cfg" style={graphColumns}>
          <GraphPanel graph={dataflowGraph} title={`Dataflow · ${DATAFLOW_PROJECTIONS.find((item) => item.id === projection)?.label ?? projection}`} grid={grid} labels={labels} selectedId={selectedId} onSelect={selectNode} onClear={onClearGraph} />
          <ResizeHandle orientation="vertical" onDelta={(delta) => setInspectorWidth((width) => Math.min(520, Math.max(190, width - delta)))} />
          <InspectorPanel graph={graphForInspector} selectedId={selectedId} stale={analysisStale} onNavigate={onNavigate} />
        </div>
      ) : null}

      {tab === 'disassembly' && binarySummary ? (
        <div className="disassembly-browser-shell">
          <div className="disassembly-browser-tabs">
            {DISASSEMBLY_VIEWS.map(({ id, label, icon: Icon }) => <button key={id} className={disassemblyView === id ? 'active' : ''} onClick={() => setDisassemblyView(id)}><Icon size={13} />{label}</button>)}
          </div>
          <div className="disassembly-browser-content">
            {disassemblyView === 'functions' ? (
              <div className="disassembly-function-browser">
                <div className="binary-view-heading"><GitBranch size={15} /><div><strong>Functions</strong><span>{functions.length} discovered functions · selecting one updates CFG and the disassembly viewer</span></div></div>
                <FunctionTree functions={functions} activeAddress={binarySummary.rootAddress} onSelect={selectFunction} />
              </div>
            ) : <BinaryModelView summary={binarySummary} view={disassemblyView} onNavigate={navigateAddress} />}
          </div>
        </div>
      ) : null}
    </section>
  );
}
