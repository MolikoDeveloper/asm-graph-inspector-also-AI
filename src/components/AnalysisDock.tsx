import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Binary, Boxes, Braces, GitBranch, GitFork, Grid2X2, MemoryStick, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { AnalysisGraph } from '../features/analysis/model';
import { analyzeDataflow, projectDataflow, type DataflowProjection } from '../features/analysis/dataflow';
import { buildBinaryStructureGraph } from '../features/analysis/binaryStructureGraph';
import { buildProgramFlow, type ProgramFlowScope } from '../features/analysis/programFlow';
import type { BinaryAnalysisSummary } from '../features/binary/model';
import { graphNodeForAddress, type ExecutionTraceProjection } from '../features/execution/follow';
import { BinaryModelView, type BinaryModelViewKind } from './BinaryModelView';
import { FunctionTree } from './FunctionTree';
import { GraphPanel } from './GraphPanel';
import { InspectorPanel } from './InspectorPanel';
import { ProgramFlowToolbar } from './ProgramFlowToolbar';
import { ResizeHandle } from './ResizeHandle';

type AnalysisTab = 'structure' | 'cfg' | 'dataflow' | 'disassembly';
type DisassemblyView = 'functions' | BinaryModelViewKind;
type CfgView = 'program' | 'function';

const INSPECTOR_VISIBILITY_KEY = 'asm-graph-inspector.analysis-properties-visible';

const BINARY_TABS: Array<{ id: AnalysisTab; label: string; icon: typeof GitBranch }> = [
  { id: 'structure', label: 'Structure', icon: Boxes },
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

function initialInspectorVisibility(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(INSPECTOR_VISIBILITY_KEY) !== '0';
}

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
  onSelectFunction,
  executionAddress = null,
  executionTrace = null
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
  executionAddress?: number | null;
  executionTrace?: ExecutionTraceProjection | null;
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
  const [inspectorVisible, setInspectorVisible] = useState(initialInspectorVisibility);
  const binaryFileId = binarySummary?.image.sourceFileId ?? null;

  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_VISIBILITY_KEY, inspectorVisible ? '1' : '0');
  }, [inspectorVisible]);

  useEffect(() => {
    if (!binarySummary && (tab === 'structure' || tab === 'disassembly')) setTab('cfg');
  }, [binarySummary, tab]);

  useEffect(() => {
    setSummaryHistory(new Map());
    setHiddenGroups(new Set());
    setExpandedGroups(new Set());
    setProgramScope('visited');
    if (binaryFileId) {
      setTab('structure');
      onSelect(null);
    }
  }, [binaryFileId, onSelect]);

  useEffect(() => {
    if (!binarySummary) return;
    setSummaryHistory((current) => {
      const next = new Map(current);
      next.set(binarySummary.rootAddress, binarySummary);
      return next;
    });
  }, [binarySummary]);

  const functions = useMemo(() => binarySummary ? [...binarySummary.functions].sort((a, b) => a.address - b.address) : [], [binarySummary]);
  const structureGraph = useMemo(() => binarySummary ? buildBinaryStructureGraph(binarySummary) : null, [binarySummary]);
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
      staticTransfers: binarySummary.programTransfers,
      entryAddress: binarySummary.image.entry,
      activeAddress: binarySummary.rootAddress,
      scope: programScope,
      hiddenGroups,
      expandedGroups
    });
  }, [binarySummary, summaryHistory, programScope, hiddenGroups, expandedGroups]);
  const cfgGraph = binarySummary && cfgView === 'program' ? programFlow?.graph ?? graph : graph;
  const executionNodeId = useMemo(() => tab === 'cfg' && cfgView === 'function' && executionAddress !== null ? graphNodeForAddress(graph, executionAddress)?.id ?? null : null, [cfgView, executionAddress, graph, tab]);
  const graphForInspector = tab === 'structure' ? structureGraph : tab === 'dataflow' ? dataflowGraph : tab === 'cfg' ? cfgGraph : graph;
  const tabs = binarySummary ? BINARY_TABS : SOURCE_TABS;

  useEffect(() => {
    // Graphs start unselected. A stale selection from another tab/view is cleared instead of
    // silently selecting the first node, so path illumination only appears after user inspection.
    if (!selectedId) return;
    if (tab === 'disassembly' || !graphForInspector || !graphForInspector.nodes.some((node) => node.id === selectedId)) onSelect(null);
  }, [graphForInspector, selectedId, onSelect, tab]);

  useEffect(() => {
    if (binarySummary && executionAddress !== null && executionAddress !== undefined) {
      setTab('cfg');
      setCfgView('function');
      return;
    }
    if (!binarySummary && executionTrace?.currentNodeId) setTab('cfg');
  }, [binarySummary, executionAddress, executionTrace?.currentNodeId]);

  useEffect(() => {
    if (!executionNodeId) return;
    if (selectedId === executionNodeId) return;
    onSelect(executionNodeId);
  }, [executionNodeId, onSelect, selectedId]);

  const navigateAddress = (address: number) => onNavigate({ address });
  const selectFunction = (address: number) => {
    onSelectFunction(address);
    navigateAddress(address);
  };

  const functionContaining = (address: number) => functions.find((fn) => fn.address === address)
    ?? functions.find((fn) => fn.endAddress !== null && address >= fn.address && address < fn.endAddress)
    ?? null;

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
  };

  const activateNode = (id: string) => {
    if (!graphForInspector) return;

    // Program-flow double click means "enter this entity". A function opens its Function CFG;
    // compact namespace groups expand/collapse; PLT/reference nodes navigate to their address.
    if (tab === 'cfg' && cfgView === 'program' && programFlow) {
      const action = programFlow.actions.get(id);
      if (action?.kind === 'function') {
        setCfgView('function');
        selectFunction(action.address);
        onSelect(null);
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
    if (!node) return;

    // A basic block already is the detail unit in Function CFG. Double click only drills into
    // reference/function nodes; it must not behave like a second selection/navigation gesture.
    if (tab === 'cfg' && cfgView === 'function') {
      if (node.blockInstructions?.length) return;
      if (node.address === undefined) return;
      const targetFunction = functionContaining(node.address);
      if (targetFunction) {
        selectFunction(targetFunction.address);
        onSelect(null);
      } else {
        navigateAddress(node.address);
      }
      return;
    }

    // Structure nodes representing functions drill into the Function CFG. Other address-bearing
    // binary components drill into their disassembly location. Non-address summary nodes have no
    // deeper view, so double click is intentionally a no-op.
    if (tab === 'structure') {
      if (node.address === undefined) return;
      const targetFunction = functionContaining(node.address);
      if (targetFunction && (node.category ?? '').toUpperCase().includes('FUNCTION')) {
        setTab('cfg');
        setCfgView('function');
        selectFunction(targetFunction.address);
        onSelect(null);
      } else {
        navigateAddress(node.address);
      }
      return;
    }

    // Dataflow/source nodes may expose an instruction/source address. That address is their deeper
    // detail. Values/lanes without an address remain inspection-only.
    if (node.address !== undefined) navigateAddress(node.address);
  };

  const graphColumns = {
    gridTemplateColumns: inspectorVisible
      ? `minmax(180px, 1fr) 4px minmax(190px, min(${inspectorWidth}px, 38%))`
      : 'minmax(0, 1fr)'
  };

  const toggleGroupVisibility = (groupId: string) => {
    setHiddenGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const inspectorToggle = tab !== 'disassembly' ? (
    <button
      type="button"
      className={`analysis-properties-toggle ${inspectorVisible ? 'active' : ''}`}
      onClick={() => setInspectorVisible((value) => !value)}
      title={inspectorVisible ? 'Hide Properties' : 'Show Properties'}
      aria-pressed={inspectorVisible}
    >
      {inspectorVisible ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
      <span>Properties</span>
    </button>
  ) : null;

  return (
    <section className="analysis-dock-shell">
      <header className="analysis-tabbar">
        <div className="analysis-tabstrip">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); onSelect(null); }}><Icon size={13} />{label}</button>)}
        </div>
        <div className="analysis-context-controls">
          {analysisStale ? <span className="analysis-stale-badge">Last valid snapshot</span> : null}
          {binarySummary && tab === 'structure' ? <span className="binary-structure-summary">ELF64 · {binarySummary.image.kind} · {binarySummary.image.sections.length} sections · {binarySummary.functions.length} functions</span> : null}
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
          {binarySummary && (tab === 'cfg' || tab === 'dataflow') ? <label className="function-picker"><Binary size={13} /><span>Function</span><select value={binarySummary.rootAddress} onChange={(event: ChangeEvent<HTMLSelectElement>) => selectFunction(Number(event.currentTarget.value))}>{functions.map((fn) => <option key={`${fn.address}:${fn.name}`} value={fn.address}>{fn.name} · 0x{fn.address.toString(16)}</option>)}</select></label> : null}
          {inspectorToggle}
        </div>
      </header>

      {tab === 'structure' && binarySummary ? (
        <div className={`analysis-dock analysis-dock-cfg binary-structure-dock ${inspectorVisible ? '' : 'inspector-collapsed'}`} style={graphColumns}>
          <GraphPanel
            graph={structureGraph}
            title={`Binary structure · ${binarySummary.image.sourcePath.split('/').at(-1) ?? binarySummary.image.sourcePath}`}
            grid={grid}
            labels={labels}
            selectedId={selectedId}
            onSelect={selectNode}
            onActivate={activateNode}
          />
          {inspectorVisible ? <ResizeHandle orientation="vertical" onDelta={(delta) => setInspectorWidth((width) => Math.min(520, Math.max(190, width - delta)))} /> : null}
          {inspectorVisible ? <InspectorPanel graph={structureGraph} selectedId={selectedId} onNavigate={onNavigate} /> : null}
        </div>
      ) : null}

      {tab === 'cfg' ? (
        <div className={`cfg-view-shell ${!binarySummary || cfgView === 'function' ? 'function-only' : ''} ${inspectorVisible ? '' : 'inspector-collapsed'}`}>
          {binarySummary && cfgView === 'program' && programFlow ? (
            <ProgramFlowToolbar
              groups={programFlow.groups}
              hiddenGroups={hiddenGroups}
              expandedGroups={expandedGroups}
              scope={programScope}
              visitedCount={programFlow.visitedCount}
              activeName={binarySummary.rootName}
              onScopeChange={setProgramScope}
              onToggleVisibility={toggleGroupVisibility}
              onShowAll={() => setHiddenGroups(new Set())}
              onHideAll={() => setHiddenGroups(new Set(programFlow.groups.map((group) => group.id)))}
              onCompactAll={() => setExpandedGroups(new Set())}
            />
          ) : null}
          <div className="analysis-dock analysis-dock-cfg" style={graphColumns}>
            <GraphPanel graph={cfgGraph} title={binarySummary && cfgView === 'program' ? `Program calls · ${binarySummary.programTransfers.length} edges` : graph?.viewKind === 'function-cfg' ? 'Function CFG' : 'Flow graph'} grid={grid} labels={labels} selectedId={selectedId} focusId={executionNodeId} trace={cfgView === 'function' || !binarySummary ? executionTrace : null} onSelect={selectNode} onActivate={activateNode} onClear={onClearGraph} />
            {inspectorVisible ? <ResizeHandle orientation="vertical" onDelta={(delta) => setInspectorWidth((width) => Math.min(520, Math.max(190, width - delta)))} /> : null}
            {inspectorVisible ? <InspectorPanel graph={cfgGraph} selectedId={selectedId} stale={analysisStale} onNavigate={onNavigate} /> : null}
          </div>
        </div>
      ) : null}

      {tab === 'dataflow' ? (
        <div className={`analysis-dock analysis-dock-cfg ${inspectorVisible ? '' : 'inspector-collapsed'}`} style={graphColumns}>
          <GraphPanel graph={dataflowGraph} title={`Dataflow · ${DATAFLOW_PROJECTIONS.find((item) => item.id === projection)?.label ?? projection}`} grid={grid} labels={labels} selectedId={selectedId} onSelect={selectNode} onActivate={activateNode} onClear={onClearGraph} />
          {inspectorVisible ? <ResizeHandle orientation="vertical" onDelta={(delta) => setInspectorWidth((width) => Math.min(520, Math.max(190, width - delta)))} /> : null}
          {inspectorVisible ? <InspectorPanel graph={graphForInspector} selectedId={selectedId} stale={analysisStale} onNavigate={onNavigate} /> : null}
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
