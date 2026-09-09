import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { analyzeAssemblyChecked, type AssemblyProblem } from '../features/analysis/asmParser';
import { analyzeBinary, clearBinaryAnalysisCache } from '../features/analysis/binaryAnalysis';
import { clearFullDisassemblyCache } from '../features/analysis/binaryDisassembly';
import type { AnalysisGraph, GraphNode } from '../features/analysis/model';
import type { BinaryAnalysisSummary } from '../features/binary/model';
import { loadCapstone, type CapstoneStatus } from '../features/capstone/capstoneLoader';
import { importBrowserFile } from '../features/project/fileImport';
import { downloadProjectBundle } from '../features/project/projectExport';
import { useProjectController } from '../features/project/useProjectController';
import { useGlobalDependencies } from '../features/dependencies/useGlobalDependencies';
import { executionSupportForTarget, useExecutionController } from '../features/execution/useExecutionController';
import { executionAddressFromSnapshot, findBinaryFunctionForAddress, graphNodeForAddress, imageContainsExecutableAddress, projectExecutionTrace } from '../features/execution/follow';
import type { ExecutionSupport, ExecutionTarget } from '../features/execution/model';
import { canResolveExecutionTargetFromFile, resolveBinaryExecutionTarget } from '../features/execution/targetResolution';
import type { ProjectFile } from '../features/project/model';
import type { AssemblerBackend } from '../features/toolchain/model';
import { ensureAssemblyExecutable } from '../features/toolchain/assemblyExecutionArtifact';
import { buildAssemblyProject } from '../features/toolchain/projectAssemblyBuild';
import { createPinnedNasmLdAssemblerBackend } from '../features/toolchain/pinnedNasmLdToolchain';
import { initialWorkspaceState, type EditorRevealTarget } from '../features/workspace/model';
import { workspaceReducer } from '../features/workspace/workspaceReducer';
import { makeId } from '../shared/id';
import { useAppSettings } from './settings';
import { ActivityBar } from '../components/ActivityBar';
import { AboutDialog } from '../components/AboutDialog';
import { BottomPanel, type OutputEntry } from '../components/BottomPanel';
import type { InspectorTerminalCommandResult } from '../components/InspectorTerminal';
import { EditorWorkspace } from '../components/EditorWorkspace';
import { AnalysisDock } from '../components/AnalysisDock';
import { MenuBar, type MenuDefinition } from '../components/MenuBar';
import { NewFileDialog } from '../components/NewFileDialog';
import { ProjectExplorer } from '../components/ProjectExplorer';
import { ProjectGate } from '../components/ProjectGate';
import { ResizeHandle } from '../components/ResizeHandle';
import { SettingsDialog } from '../components/SettingsDialog';
import { StatusBar } from '../components/StatusBar';

const AUTO_STEP_INTERVAL_MS = 50;

type RuntimeOutputChannel = 'terminal' | 'diagnostics';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

export function App() {
  const projects = useProjectController();
  const { settings, setSettings } = useAppSettings();
  const globalDependencies = useGlobalDependencies();
  const execution = useExecutionController();
  const [workspace, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileInitialPath, setNewFileInitialPath] = useState('src/new.asm');
  const [searchQuery, setSearchQuery] = useState('');
  const [graphs, setGraphs] = useState<Map<string, AnalysisGraph>>(() => new Map());
  const [binarySummaries, setBinarySummaries] = useState<Map<string, BinaryAnalysisSummary>>(() => new Map());
  const [problemsByFile, setProblemsByFile] = useState<Map<string, AssemblyProblem[]>>(() => new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [revealTarget, setRevealTarget] = useState<EditorRevealTarget | null>(null);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [capstoneStatus, setCapstoneStatus] = useState<CapstoneStatus>('idle');
  const [assemblyBusy, setAssemblyBusy] = useState(false);
  const [runtimeOutputChannel, setRuntimeOutputChannel] = useState<RuntimeOutputChannel>('terminal');
  const [autoStepping, setAutoStepping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const lastProjectId = useRef<string | null>(null);
  const graphsRef = useRef(graphs);
  const selectedNodeRef = useRef(selectedNodeId);
  const activeFileIdRef = useRef<string | null>(null);
  const sourceAnalysisTimers = useRef(new Map<string, number>());
  const binaryRequestSequence = useRef(new Map<string, number>());
  const revealSequence = useRef(0);
  const executionFollowKey = useRef<string | null>(null);
  const executionAnalysisKey = useRef<string | null>(null);
  const assemblyBackendRef = useRef<Promise<AssemblerBackend> | null>(null);
  const autoStepTargetRef = useRef<ExecutionTarget | null>(null);
  const autoStepBusyRef = useRef(false);

  const project = projects.project;
  const activeGroup = workspace.groups.find((group) => group.id === workspace.activeGroupId) ?? workspace.groups[0];
  const activeFile = project && activeGroup.activeFileId ? project.files.find((file) => file.id === activeGroup.activeFileId) ?? null : null;
  const activeGraph = activeFile ? graphs.get(activeFile.id) ?? null : null;
  const activeBinarySummary = activeFile ? binarySummaries.get(activeFile.id) ?? null : null;
  const activeProblems = activeFile ? problemsByFile.get(activeFile.id) ?? [] : [];
  const activeAsmBuildable = activeFile?.kind === 'text' && activeFile.language === 'asm';
  const executionTarget = useMemo<ExecutionTarget | null>(() => {
    if (activeFile?.kind === 'binary' && activeBinarySummary) return { kind: 'binary', file: activeFile, image: activeBinarySummary.image };
    return null;
  }, [activeFile, activeBinarySummary]);
  const activeExecutionSupport = useMemo<ExecutionSupport | null>(() => {
    if (activeAsmBuildable) {
      return {
        supported: true,
        provider: null,
        reasons: [],
        notes: ['ASM Run/Step assembles the source with pinned NASM + GNU ld, opens the generated ELF, then executes the real binary. The legacy source-semantic interpreter is not used by the normal UI path.']
      };
    }
    return executionTarget ? executionSupportForTarget(executionTarget) : null;
  }, [activeAsmBuildable, executionTarget]);
  const activeExecutionActionable = canResolveExecutionTargetFromFile(activeFile)
    && activeExecutionSupport?.supported !== false;
  const executionAddress = useMemo(() => executionAddressFromSnapshot(execution.snapshot), [execution.snapshot]);
  const executionTrace = useMemo(() => projectExecutionTrace(activeGraph, execution.snapshot), [activeGraph, execution.snapshot]);

  useEffect(() => { graphsRef.current = graphs; }, [graphs]);
  useEffect(() => { selectedNodeRef.current = selectedNodeId; }, [selectedNodeId]);
  useEffect(() => { activeFileIdRef.current = activeFile?.id ?? null; }, [activeFile?.id]);
  useEffect(() => {
    if (execution.snapshot.targetFileId && execution.snapshot.targetFileId !== (activeFile?.id ?? null)) {
      setAutoStepping(false);
      autoStepTargetRef.current = null;
      autoStepBusyRef.current = false;
      execution.clear();
    }
  }, [activeFile?.id, execution.snapshot.targetFileId, execution.clear]);

  useEffect(() => {
    if (execution.snapshot.status === 'idle') {
      executionFollowKey.current = null;
      executionAnalysisKey.current = null;
    }
  }, [execution.snapshot.status]);

  const log = useCallback((message: string, level: OutputEntry['level'] = 'info') => {
    setOutput((entries) => [...entries.slice(-399), { id: makeId('log'), time: Date.now(), level, message }]);
  }, []);

  const getAssemblyBackend = useCallback((): Promise<AssemblerBackend> => {
    if (!assemblyBackendRef.current) {
      assemblyBackendRef.current = createPinnedNasmLdAssemblerBackend().catch((error: unknown) => {
        assemblyBackendRef.current = null;
        throw error;
      });
    }
    return assemblyBackendRef.current;
  }, []);

  const reveal = useCallback((fileId: string, target: { line?: number; address?: number }) => {
    if ((!target.line || target.line <= 0) && target.address === undefined) return;
    revealSequence.current += 1;
    setRevealTarget({ fileId, line: target.line && target.line > 0 ? target.line : undefined, address: target.address, nonce: revealSequence.current });
  }, []);

  const commitGraph = useCallback((fileId: string, graph: AnalysisGraph) => {
    const previousGraph = graphsRef.current.get(fileId) ?? null;
    const previousSelected = selectedNodeRef.current;
    const previousNode = previousSelected ? previousGraph?.nodes.find((node) => node.id === previousSelected) ?? null : null;
    setGraphs((current) => {
      const next = new Map(current);
      next.set(fileId, graph);
      return next;
    });
    if (activeFileIdRef.current !== fileId) return;
    setSelectedNodeId((currentSelected) => {
      if (currentSelected && graph.nodes.some((node) => node.id === currentSelected)) return currentSelected;
      if (previousNode?.line) {
        const sameLine = graph.nodes.find((node) => node.line === previousNode.line);
        if (sameLine) return sameLine.id;
      }
      if (previousNode?.address !== undefined) {
        const sameAddress = graph.nodes.find((node) => node.address === previousNode.address || node.blockInstructions?.some((instruction) => previousNode.address! >= instruction.address && previousNode.address! < instruction.endAddress));
        if (sameAddress) return sameAddress.id;
      }
      return graph.nodes[0]?.id ?? null;
    });
  }, []);

  const analyzeSourceCandidate = useCallback((file: ProjectFile, text: string, announce = false) => {
    if (file.kind !== 'text' || file.language !== 'asm') return false;
    const candidate = analyzeAssemblyChecked(file.id, text);
    setProblemsByFile((current) => {
      const next = new Map(current);
      if (candidate.problems.length) next.set(file.id, candidate.problems);
      else next.delete(file.id);
      return next;
    });
    if (!candidate.valid) return false;
    commitGraph(file.id, candidate.graph);
    if (announce) log(`Analyzed ${file.path}: ${candidate.graph.nodes.length} nodes, ${candidate.graph.edges.length} edges.`, 'success');
    return true;
  }, [commitGraph, log]);

  const scheduleSourceAnalysis = useCallback((file: ProjectFile, text: string) => {
    const existing = sourceAnalysisTimers.current.get(file.id);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      sourceAnalysisTimers.current.delete(file.id);
      analyzeSourceCandidate(file, text, false);
    }, 320);
    sourceAnalysisTimers.current.set(file.id, timer);
  }, [analyzeSourceCandidate]);

  const runBinaryAnalysis = useCallback(async (file: ProjectFile, functionAddress?: number, announce = true) => {
    if (file.kind !== 'binary') return;
    const request = (binaryRequestSequence.current.get(file.id) ?? 0) + 1;
    binaryRequestSequence.current.set(file.id, request);
    setCapstoneStatus('loading');
    if (announce) log(`Parsing raw ELF and loading Capstone x86 for ${file.name}…`);
    try {
      const result = await analyzeBinary(file, { functionAddress });
      if (binaryRequestSequence.current.get(file.id) !== request) return;
      setCapstoneStatus('ready');
      commitGraph(file.id, result.graph);
      setBinarySummaries((current) => {
        const next = new Map(current);
        next.set(file.id, result.summary);
        return next;
      });
      if (announce) {
        for (const diagnostic of result.graph.diagnostics) log(diagnostic, 'muted');
        log(`Analyzed ${file.path} · ${result.summary.rootName}: ${result.summary.instructions.length} canonical instructions, ${result.graph.nodes.length} CFG/reference nodes.`, 'success');
      }
    } catch (error: unknown) {
      if (binaryRequestSequence.current.get(file.id) !== request) return;
      setCapstoneStatus('error');
      log(`Binary analysis failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      // Transactional semantics: previous graph/summary/inspector remain intact on failure.
    }
  }, [commitGraph, log]);

  const runAnalysis = useCallback(async (functionAddress?: number) => {
    if (!activeFile) {
      log('No active file to analyze.', 'error');
      return;
    }
    if (activeFile.kind === 'binary') {
      await runBinaryAnalysis(activeFile, functionAddress, true);
      return;
    }
    if (activeFile.language !== 'asm') {
      log(`${activeFile.name} is not an ASM source file.`, 'error');
      return;
    }
    const valid = analyzeSourceCandidate(activeFile, activeFile.text ?? '', true);
    if (!valid) log(`Analysis not committed: ${activeFile.path} contains syntax problems. The last valid graph and inspector state were preserved.`, 'error');
  }, [activeFile, analyzeSourceCandidate, log, runBinaryAnalysis]);

  useEffect(() => {
    const id = project?.id ?? null;
    if (id === lastProjectId.current) return;
    lastProjectId.current = id;
    dispatch({ type: 'reset' });
    clearBinaryAnalysisCache();
    clearFullDisassemblyCache();
    execution.clear();
    setAutoStepping(false);
    autoStepTargetRef.current = null;
    autoStepBusyRef.current = false;
    setGraphs(new Map());
    setBinarySummaries(new Map());
    setProblemsByFile(new Map());
    setSelectedNodeId(null);
    setRevealTarget(null);
    if (project) {
      const first = project.files[0];
      if (first) dispatch({ type: 'open-file', fileId: first.id });
      log(`Project loaded: ${project.name}`, 'success');
    }
  }, [project?.id, project, log, execution.clear]);

  useEffect(() => {
    if (!activeFile || activeFile.kind !== 'binary') return;
    if (execution.snapshot.targetFileId !== activeFile.id) return;
    if (executionAddress === null || !activeBinarySummary) return;

    if (imageContainsExecutableAddress(activeBinarySummary, executionAddress)) {
      const nextRevealKey = `${activeFile.id}:${executionAddress}`;
      if (executionFollowKey.current !== nextRevealKey) {
        executionFollowKey.current = nextRevealKey;
        reveal(activeFile.id, { address: executionAddress });
      }
    }

    const targetFunctionAddress = findBinaryFunctionForAddress(activeBinarySummary, executionAddress);
    if (targetFunctionAddress !== null && targetFunctionAddress !== activeBinarySummary.rootAddress) {
      const nextAnalysisKey = `${activeFile.id}:${targetFunctionAddress}`;
      if (executionAnalysisKey.current !== nextAnalysisKey) {
        executionAnalysisKey.current = nextAnalysisKey;
        void runBinaryAnalysis(activeFile, targetFunctionAddress, false).finally(() => {
          if (executionAnalysisKey.current === nextAnalysisKey) executionAnalysisKey.current = null;
        });
      }
      return;
    }

    executionAnalysisKey.current = null;
    const currentNode = graphNodeForAddress(activeGraph, executionAddress);
    if (currentNode && selectedNodeRef.current !== currentNode.id) setSelectedNodeId(currentNode.id);
  }, [activeBinarySummary, activeFile, activeGraph, execution.snapshot.targetFileId, executionAddress, reveal, runBinaryAnalysis]);

  useEffect(() => {
    // Legacy-only source-semantic follow path. Normal UI Run/Step compiles ASM to ELF first.
    if (!activeFile || activeFile.kind !== 'text' || activeFile.language !== 'asm') return;
    if (execution.snapshot.targetFileId !== activeFile.id) return;
    if (execution.snapshot.status !== 'paused') return;
    const instruction = execution.snapshot.lastInstruction;
    if (!instruction?.line) return;
    const nextRevealKey = `${activeFile.id}:line:${instruction.line}`;
    if (executionFollowKey.current !== nextRevealKey) {
      executionFollowKey.current = nextRevealKey;
      reveal(activeFile.id, { line: instruction.line });
    }
    if (instruction.nodeId && activeGraph?.nodes.some((node) => node.id === instruction.nodeId) && selectedNodeRef.current !== instruction.nodeId) {
      setSelectedNodeId(instruction.nodeId);
    }
  }, [activeFile, activeGraph, execution.snapshot.lastInstruction, execution.snapshot.status, execution.snapshot.targetFileId, reveal]);

  useEffect(() => {
    if (!activeFile) return;
    const existingGraph = graphsRef.current.get(activeFile.id);
    setSelectedNodeId(existingGraph?.nodes[0]?.id ?? null);
    if (activeFile.kind === 'binary') {
      if (!binarySummaries.has(activeFile.id)) void runBinaryAnalysis(activeFile, undefined, true);
      return;
    }
    if (activeFile.language === 'asm') analyzeSourceCandidate(activeFile, activeFile.text ?? '', !existingGraph);
    // Deliberately keyed by file identity: edits are handled by the debounced transactional path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.id]);

  useEffect(() => () => {
    for (const timer of sourceAnalysisTimers.current.values()) window.clearTimeout(timer);
    sourceAnalysisTimers.current.clear();
  }, []);

  const importFiles = useCallback(async (list: FileList | null) => {
    if (!project || !list?.length) return;
    const imported = await Promise.all([...list].map((file) => importBrowserFile(file)));
    projects.addFiles(imported);
    const first = imported[0];
    if (first) dispatch({ type: 'open-file', fileId: first.id });
    log(`Imported ${imported.length} file${imported.length === 1 ? '' : 's'} into ${project.name}.`, 'success');
  }, [project, projects, log]);

  const openNewFileDialog = useCallback((directory = '') => {
    const clean = directory.replace(/^\/+|\/+$/g, '');
    setNewFileInitialPath(clean ? `${clean}/new.asm` : 'new.asm');
    setNewFileOpen(true);
  }, []);

  const deleteFile = useCallback((fileId: string) => {
    const file = project?.files.find((candidate) => candidate.id === fileId);
    const timer = sourceAnalysisTimers.current.get(fileId);
    if (timer !== undefined) window.clearTimeout(timer);
    sourceAnalysisTimers.current.delete(fileId);
    projects.removeFile(fileId);
    dispatch({ type: 'remove-file', fileId });
    clearBinaryAnalysisCache(fileId);
    clearFullDisassemblyCache(fileId);
    setGraphs((current) => { const next = new Map(current); next.delete(fileId); return next; });
    setBinarySummaries((current) => { const next = new Map(current); next.delete(fileId); return next; });
    setProblemsByFile((current) => { const next = new Map(current); next.delete(fileId); return next; });
    if (file) log(`Deleted ${file.path}.`, 'success');
  }, [project, projects, log]);

  const deleteFolder = useCallback((folderPath: string) => {
    const ids = projects.removeFolder(folderPath);
    for (const id of ids) {
      dispatch({ type: 'remove-file', fileId: id });
      clearBinaryAnalysisCache(id);
      clearFullDisassemblyCache(id);
    }
    if (ids.length) {
      const removed = new Set(ids);
      setGraphs((current) => new Map([...current].filter(([id]) => !removed.has(id))));
      setBinarySummaries((current) => new Map([...current].filter(([id]) => !removed.has(id))));
      setProblemsByFile((current) => new Map([...current].filter(([id]) => !removed.has(id))));
      log(`Deleted ${ids.length} file${ids.length === 1 ? '' : 's'} under ${folderPath}/.`, 'success');
    }
  }, [projects, log]);

  const renameFile = useCallback((fileId: string, path: string) => {
    const clean = path.trim().replace(/^\/+/, '');
    if (!clean || project?.files.some((file) => file.id !== fileId && file.path === clean)) {
      log(`Cannot rename file: ${clean || 'empty path'} already exists or is invalid.`, 'error');
      return;
    }
    projects.renameFile(fileId, clean);
  }, [project, projects, log]);

  const moveFile = useCallback((fileId: string, directory: string) => {
    const file = project?.files.find((candidate) => candidate.id === fileId);
    if (!file) return;
    const cleanDirectory = directory.trim().replace(/^\/+|\/+$/g, '');
    const path = cleanDirectory ? `${cleanDirectory}/${file.name}` : file.name;
    if (project?.files.some((candidate) => candidate.id !== fileId && candidate.path === path)) {
      log(`Cannot move ${file.name}: ${path} already exists.`, 'error');
      return;
    }
    projects.moveFile(fileId, cleanDirectory);
  }, [project, projects, log]);

  const duplicateFile = useCallback((fileId: string, path: string) => {
    const copy = projects.duplicateFile(fileId, path);
    if (!copy) { log(`Cannot duplicate file to ${path}.`, 'error'); return; }
    dispatch({ type: 'open-file', fileId: copy.id });
    log(`Duplicated file as ${copy.path}.`, 'success');
  }, [projects, log]);

  const navigateFromNode = useCallback((node: { line?: number; address?: number }) => {
    const fileId = activeFileIdRef.current;
    if (fileId) reveal(fileId, node);
  }, [reveal]);

  const selectOutlineNode = useCallback((id: string) => {
    setSelectedNodeId(id);
    const fileId = activeFileIdRef.current;
    const node = fileId ? graphsRef.current.get(fileId)?.nodes.find((candidate) => candidate.id === id) : null;
    if (fileId && node) reveal(fileId, node);
  }, [reveal]);

  const clearActiveGraph = useCallback(() => {
    if (!activeFile) return;
    setGraphs((current) => {
      const next = new Map(current);
      next.delete(activeFile.id);
      return next;
    });
    setSelectedNodeId(null);
  }, [activeFile]);

  const selectBinaryFunction = useCallback((address: number) => {
    if (activeFile?.kind !== 'binary') return;
    void runBinaryAnalysis(activeFile, address, false);
  }, [activeFile, runBinaryAnalysis]);

  const analyzeBinaryTarget = useCallback(async (file: ProjectFile, announceDiagnostics: boolean): Promise<ExecutionTarget> => {
    if (file.kind !== 'binary' || !file.bytes) throw new Error(`${file.path} is not an executable binary artifact.`);
    setCapstoneStatus('loading');
    const analyzed = await analyzeBinary(file);
    setCapstoneStatus('ready');
    commitGraph(file.id, analyzed.graph);
    setBinarySummaries((current) => {
      const next = new Map(current);
      next.set(file.id, analyzed.summary);
      return next;
    });
    if (announceDiagnostics) for (const diagnostic of analyzed.graph.diagnostics) log(diagnostic, 'muted');
    return { kind: 'binary', file, image: analyzed.summary.image };
  }, [commitGraph, log]);

  const resolveActiveAsmExecutionTarget = useCallback(async (): Promise<{ target: ExecutionTarget; rebuilt: boolean } | null> => {
    if (!project || activeFile?.kind !== 'text' || activeFile.language !== 'asm') {
      log('ASM execution requires an active ASM source file.', 'error');
      return null;
    }
    if (assemblyBusy) return null;

    setAssemblyBusy(true);
    try {
      const backend = await getAssemblyBackend();
      log(`Building execution artifact for ${activeFile.path}…`);
      const ensured = await ensureAssemblyExecutable(project, backend, { sourceFileIds: [activeFile.id] });
      const generated = ensured.file;

      if (!ensured.reused) {
        clearBinaryAnalysisCache(generated.id);
        clearFullDisassemblyCache(generated.id);
        projects.addFiles([generated]);
        for (const diagnostic of ensured.build?.assembly.diagnostics ?? []) {
          const level: OutputEntry['level'] = diagnostic.severity === 'error' ? 'error' : diagnostic.severity === 'warning' ? 'muted' : 'info';
          log(`${diagnostic.tool ? `[${diagnostic.tool}] ` : ''}${diagnostic.message}`, level);
        }
        if (ensured.build?.assembly.stdout.trim()) log(ensured.build.assembly.stdout.trim(), 'muted');
        if (ensured.build?.assembly.stderr.trim() && !ensured.build.assembly.diagnostics.length) log(ensured.build.assembly.stderr.trim(), 'muted');
      }

      dispatch({ type: 'open-file', fileId: generated.id });
      const target = await analyzeBinaryTarget(generated, !ensured.reused);
      if (ensured.reused) {
        log(`Reusing fresh ${generated.path} for ${activeFile.path}; source revision is unchanged.`, 'muted');
      } else {
        log(`Built ${activeFile.path} → ${generated.path}: ${generated.size.toLocaleString()} bytes. Execution uses the real ELF.`, 'success');
      }
      return { target, rebuilt: !ensured.reused };
    } catch (error: unknown) {
      setCapstoneStatus((current) => current === 'loading' ? 'error' : current);
      log(`ASM execution build failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return null;
    } finally {
      setAssemblyBusy(false);
    }
  }, [activeFile, analyzeBinaryTarget, assemblyBusy, getAssemblyBackend, log, project, projects]);

  const buildActiveAssembly = useCallback(async (runAfterBuild = false) => {
    if (!project || activeFile?.kind !== 'text' || activeFile.language !== 'asm') {
      log('Build requires an active ASM source file.', 'error');
      return;
    }
    if (assemblyBusy) return;

    setAssemblyBusy(true);
    if (runAfterBuild) setRuntimeOutputChannel('diagnostics');
    try {
      log(`Assembling ${activeFile.path} with pinned NASM + GNU ld…`);
      const backend = await getAssemblyBackend();
      const build = await buildAssemblyProject(project, backend, { sourceFileIds: [activeFile.id] });
      for (const diagnostic of build.assembly.diagnostics) {
        const level: OutputEntry['level'] = diagnostic.severity === 'error' ? 'error' : diagnostic.severity === 'warning' ? 'muted' : 'info';
        log(`${diagnostic.tool ? `[${diagnostic.tool}] ` : ''}${diagnostic.message}`, level);
      }
      if (build.assembly.stdout.trim()) log(build.assembly.stdout.trim(), 'muted');
      if (build.assembly.stderr.trim() && !build.assembly.diagnostics.length) log(build.assembly.stderr.trim(), 'muted');

      const generated = build.generatedFile;
      if (!generated) {
        log(`ASM build failed for ${activeFile.path}.`, 'error');
        return;
      }

      clearBinaryAnalysisCache(generated.id);
      clearFullDisassemblyCache(generated.id);
      projects.addFiles([generated]);
      dispatch({ type: 'open-file', fileId: generated.id });

      const target = await analyzeBinaryTarget(generated, true);
      const summary = binarySummaries.get(generated.id);
      log(`Built ${activeFile.path} → ${generated.path}: ${generated.size.toLocaleString()} bytes${summary ? `, ${summary.instructions.length} canonical instructions` : ''}.`, 'success');

      if (runAfterBuild) {
        const support = executionSupportForTarget(target);
        if (!support.supported) {
          log(`Generated ELF cannot execute: ${support.reasons.join(' ')}`, 'error');
          return;
        }
        execution.clear();
        await nextFrame();
        await execution.run(target);
      }
    } catch (error: unknown) {
      setCapstoneStatus((current) => current === 'loading' ? 'error' : current);
      log(`ASM build failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setAssemblyBusy(false);
    }
  }, [activeFile, analyzeBinaryTarget, assemblyBusy, binarySummaries, execution, getAssemblyBackend, log, project, projects]);

  const resolveActiveExecutionTarget = useCallback(async (): Promise<ExecutionTarget | null> => {
    if (activeAsmBuildable) return (await resolveActiveAsmExecutionTarget())?.target ?? null;
    if (activeFile?.kind === 'binary') {
      if (!activeBinarySummary) {
        log(`Preparing ${activeFile.path} for execution: analyzing ELF now; runtime dependencies will be resolved automatically.`, 'muted');
      }
      try {
        return await resolveBinaryExecutionTarget(
          activeFile,
          activeBinarySummary,
          (file) => analyzeBinaryTarget(file, false)
        );
      } catch (error: unknown) {
        log(`Execution preparation failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
        return null;
      }
    }
    log('No executable binary or ASM source is active.', 'error');
    return null;
  }, [activeAsmBuildable, activeBinarySummary, activeFile, analyzeBinaryTarget, log, resolveActiveAsmExecutionTarget]);

  const stepExecution = useCallback(async (origin: RuntimeOutputChannel = 'diagnostics') => {
    setRuntimeOutputChannel(origin);
    const target = await resolveActiveExecutionTarget();
    if (!target) return;
    await execution.step(target);
  }, [execution, resolveActiveExecutionTarget]);

  const runExecution = useCallback(async (origin: RuntimeOutputChannel = 'diagnostics') => {
    setRuntimeOutputChannel(origin);
    const target = await resolveActiveExecutionTarget();
    if (!target) return;
    await execution.run(target);
  }, [execution, resolveActiveExecutionTarget]);

  const resetExecution = useCallback(async () => {
    setAutoStepping(false);
    autoStepTargetRef.current = null;
    autoStepBusyRef.current = false;
    setRuntimeOutputChannel('diagnostics');
    const target = await resolveActiveExecutionTarget();
    if (!target) return;
    await execution.reset(target);
  }, [execution, resolveActiveExecutionTarget]);

  const pauseExecution = useCallback(() => {
    setAutoStepping(false);
    autoStepTargetRef.current = null;
    autoStepBusyRef.current = false;
    execution.pause();
  }, [execution.pause]);

  const probeExecution = useCallback(async () => {
    setRuntimeOutputChannel('diagnostics');
    const target = await resolveActiveExecutionTarget();
    if (!target || target.kind !== 'binary') return;
    await execution.probe(target);
  }, [execution, resolveActiveExecutionTarget]);

  const toggleAutoStepExecution = useCallback(async () => {
    if (autoStepping) {
      setAutoStepping(false);
      autoStepTargetRef.current = null;
      autoStepBusyRef.current = false;
      return;
    }
    setRuntimeOutputChannel('diagnostics');
    const target = await resolveActiveExecutionTarget();
    if (!target) return;
    autoStepTargetRef.current = target;
    autoStepBusyRef.current = false;
    setAutoStepping(true);
  }, [autoStepping, resolveActiveExecutionTarget]);

  useEffect(() => {
    if (!autoStepping) return;
    if (execution.snapshot.status === 'exited' || execution.snapshot.status === 'halted' || execution.snapshot.status === 'trapped' || execution.snapshot.status === 'running') {
      setAutoStepping(false);
      autoStepTargetRef.current = null;
      autoStepBusyRef.current = false;
      return;
    }
    if (autoStepBusyRef.current) return;
    const timer = window.setTimeout(() => {
      const target = autoStepTargetRef.current;
      if (!target) {
        setAutoStepping(false);
        return;
      }
      autoStepBusyRef.current = true;
      void execution.step(target).finally(() => {
        autoStepBusyRef.current = false;
      });
    }, AUTO_STEP_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [autoStepping, execution, execution.snapshot.instructionCount, execution.snapshot.status, execution.snapshot.targetFileId]);

  const findProjectFile = useCallback((rawPath: string): ProjectFile | null => {
    if (!project) return null;
    const clean = rawPath.trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!clean) return null;
    const exact = project.files.find((file) => file.path === clean);
    if (exact) return exact;
    const nameMatches = project.files.filter((file) => file.name === clean);
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }, [project]);

  const runProjectBinaryFromTerminal = useCallback(async (file: ProjectFile): Promise<void> => {
    if (file.kind !== 'binary' || !file.bytes) throw new Error(`${file.path} is not an executable binary artifact.`);
    setRuntimeOutputChannel('terminal');
    setAutoStepping(false);
    autoStepTargetRef.current = null;
    autoStepBusyRef.current = false;
    dispatch({ type: 'open-file', fileId: file.id });

    const target = await resolveBinaryExecutionTarget(
      file,
      binarySummaries.get(file.id),
      (candidate) => analyzeBinaryTarget(candidate, false)
    );

    await nextFrame();
    execution.clear();
    await nextFrame();
    await execution.run(target);
  }, [analyzeBinaryTarget, binarySummaries, execution]);

  const executeTerminalCommand = useCallback(async (rawCommand: string): Promise<InspectorTerminalCommandResult> => {
    const command = rawCommand.trim();
    if (!command) return {};

    const directFile = findProjectFile(command);
    if (directFile) {
      if (directFile.kind === 'binary') {
        await runProjectBinaryFromTerminal(directFile);
        return {};
      }
      dispatch({ type: 'open-file', fileId: directFile.id });
      return { lines: [{ level: 'info', text: `Opened ${directFile.path}.` }] };
    }

    const [verbRaw, ...rest] = command.split(/\s+/);
    const verb = verbRaw.toLowerCase();
    const argument = rest.join(' ').trim();

    if (verb === 'help') {
      return {
        lines: [
          { level: 'info', text: 'Inspector commands:' },
          { level: 'muted', text: '  <project ELF path>   execute directly, e.g. build/ray_test' },
          { level: 'muted', text: '  run [path]           run the active executable or a project ELF' },
          { level: 'muted', text: '  open <path>          open a binary, source, or objdump artifact' },
          { level: 'muted', text: '  analyze <path>       analyze an ELF or ASM artifact' },
          { level: 'muted', text: '  stdin <text>         send a line to the active guest process' },
          { level: 'muted', text: '  status               show current execution state' },
          { level: 'muted', text: '  clear                clear this console' }
        ]
      };
    }

    if (verb === 'clear') return { clear: true };

    if (verb === 'status') {
      const crash = execution.snapshot.crash;
      return {
        lines: [{
          level: crash ? 'error' : 'info',
          text: `${execution.snapshot.status} · ${execution.snapshot.provider ?? 'no execution provider'} · ${execution.snapshot.instructionCount.toLocaleString()} stepped instruction(s)${execution.snapshot.exitCode !== null ? ` · exit ${execution.snapshot.exitCode}` : ''}${crash?.runtimeAddress !== null && crash?.runtimeAddress !== undefined ? ` · ${crash.signalName} @ 0x${crash.runtimeAddress.toString(16)}` : ''}`
        }]
      };
    }

    if (verb === 'run') {
      if (!argument) {
        await runExecution('terminal');
        return {};
      }
      const file = findProjectFile(argument);
      if (!file) return { lines: [{ level: 'error', text: `Project path not found: ${argument}` }] };
      if (file.kind !== 'binary') return { lines: [{ level: 'error', text: `${file.path} is not a binary artifact.` }] };
      await runProjectBinaryFromTerminal(file);
      return {};
    }

    if (verb === 'open') {
      if (!argument) return { lines: [{ level: 'error', text: 'Usage: open <project path>' }] };
      const file = findProjectFile(argument);
      if (!file) return { lines: [{ level: 'error', text: `Project path not found: ${argument}` }] };
      dispatch({ type: 'open-file', fileId: file.id });
      return { lines: [{ level: 'success', text: `Opened ${file.path}.` }] };
    }

    if (verb === 'analyze') {
      if (!argument) return { lines: [{ level: 'error', text: 'Usage: analyze <project path>' }] };
      const file = findProjectFile(argument);
      if (!file) return { lines: [{ level: 'error', text: `Project path not found: ${argument}` }] };
      dispatch({ type: 'open-file', fileId: file.id });
      if (file.kind === 'binary') {
        await analyzeBinaryTarget(file, false);
        return { lines: [{ level: 'success', text: `Analyzed ${file.path} from authoritative ELF bytes with Capstone.` }] };
      }
      if (file.language === 'asm') {
        const valid = analyzeSourceCandidate(file, file.text ?? '', false);
        return { lines: [{ level: valid ? 'success' : 'error', text: valid ? `Analyzed ${file.path}.` : `${file.path} contains syntax problems; the last valid graph was preserved.` }] };
      }
      return { lines: [{ level: 'info', text: `Opened ${file.path} as external disassembly/objdump artifact evidence. Binary bytes remain authoritative for CFG and execution.` }] };
    }

    return { lines: [{ level: 'error', text: `Unknown inspector command: ${verbRaw}. Type help for the available commands.` }] };
  }, [analyzeBinaryTarget, analyzeSourceCandidate, execution.snapshot, findProjectFile, runExecution, runProjectBinaryFromTerminal]);

  const exportCurrentProject = useCallback(() => {
    if (!project) return;
    try {
      const fileName = downloadProjectBundle(project);
      log(`Exported project as ${fileName}. Global dependencies remain external.`, 'success');
    } catch (error: unknown) {
      log(`Project export failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [project, log]);

  const menus = useMemo<MenuDefinition[]>(() => [
    {
      label: 'Project',
      items: [
        { label: 'New / Switch Project…', action: projects.closeProject },
        { label: 'Save Project', shortcut: 'Ctrl S', action: () => void projects.saveNow() },
        { label: 'Export Project…', action: exportCurrentProject },
        { separator: true, label: '' },
        { label: 'Settings…', shortcut: 'Ctrl ,', action: () => setSettingsOpen(true) }
      ]
    },
    {
      label: 'File',
      items: [
        { label: 'New File…', shortcut: 'Ctrl N', action: () => openNewFileDialog('') },
        { label: 'Import Files…', action: () => fileInputRef.current?.click() },
        { label: 'Import Folder…', action: () => folderInputRef.current?.click() },
        { separator: true, label: '' },
        { label: 'Close Active Tab', action: () => activeFile && dispatch({ type: 'close-tab', groupId: workspace.activeGroupId, fileId: activeFile.id }), disabled: !activeFile }
      ]
    },
    {
      label: 'View',
      items: [
        { label: 'Toggle Explorer', shortcut: 'Ctrl B', action: () => dispatch({ type: 'toggle-explorer' }) },
        { label: 'Toggle Analysis', action: () => dispatch({ type: 'toggle-graph' }) },
        { label: 'Toggle Bottom Panel', shortcut: 'Ctrl J', action: () => dispatch({ type: 'toggle-bottom' }) },
        { separator: true, label: '' },
        { label: 'Split Editor Right', shortcut: 'Ctrl \\', action: () => dispatch({ type: 'split-right' }) }
      ]
    },
    {
      label: 'Analysis',
      items: [
        { label: 'Reanalyze Active File', shortcut: 'F5', action: () => void runAnalysis() }
      ]
    },
    {
      label: 'Build',
      items: [
        { label: assemblyBusy ? 'Building ASM…' : 'Build Active ASM to ELF', shortcut: 'Ctrl Shift B', action: () => void buildActiveAssembly(false), disabled: !activeAsmBuildable || assemblyBusy },
        { label: 'Assemble & Run ELF', action: () => void buildActiveAssembly(true), disabled: !activeAsmBuildable || assemblyBusy }
      ]
    },
    {
      label: 'Run',
      items: [
        { label: 'Run Active Program', shortcut: 'F6', action: () => void runExecution('diagnostics'), disabled: assemblyBusy || !activeExecutionActionable || autoStepping },
        { label: 'Step Instruction', shortcut: 'F10', action: () => void stepExecution('diagnostics'), disabled: assemblyBusy || !activeExecutionActionable || execution.snapshot.status === 'running' || autoStepping },
        { label: autoStepping ? 'Stop Auto Step' : 'Auto Step', shortcut: 'F11', action: () => void toggleAutoStepExecution(), disabled: assemblyBusy || !activeExecutionActionable || execution.snapshot.status === 'running' },
        { label: 'Pause', action: pauseExecution, disabled: execution.snapshot.status !== 'running' && !autoStepping },
        { separator: true, label: '' },
        { label: 'Reset Execution', shortcut: 'Shift F5', action: () => void resetExecution(), disabled: assemblyBusy || !activeExecutionActionable },
        ...(execution.preflight.status === 'incompatible' ? [{ label: 'Probe Observed Failure', action: () => void probeExecution(), disabled: assemblyBusy || execution.snapshot.status === 'running' }] : [])
      ]
    },
    {
      label: 'Tools',
      items: [
        { label: 'Load Capstone x86', action: () => { setCapstoneStatus('loading'); void loadCapstone().then(() => { setCapstoneStatus('ready'); log('Capstone x86 loaded on demand.', 'success'); }).catch((error: unknown) => { setCapstoneStatus('error'); log(String(error), 'error'); }); } },
        { label: 'Settings…', action: () => setSettingsOpen(true) }
      ]
    },
    { label: 'Help', items: [{ label: 'About', action: () => setAboutOpen(true) }] }
  ], [activeExecutionActionable, activeFile, activeAsmBuildable, assemblyBusy, autoStepping, buildActiveAssembly, execution.preflight.status, execution.snapshot.status, exportCurrentProject, log, openNewFileDialog, pauseExecution, probeExecution, projects, resetExecution, runAnalysis, runExecution, stepExecution, toggleAutoStepExecution, workspace.activeGroupId]);

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    if (globalDependencies.revision <= 0) return;
    clearBinaryAnalysisCache();
    clearFullDisassemblyCache();
    if (activeFile?.kind === 'binary') void runBinaryAnalysis(activeFile, activeBinarySummary?.rootAddress, true);
    // revision deliberately drives re-resolution against the global registry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalDependencies.revision]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void projects.saveNow(); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); void buildActiveAssembly(false); return; }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'b') { event.preventDefault(); dispatch({ type: 'toggle-explorer' }); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); dispatch({ type: 'toggle-bottom' }); }
      if ((event.ctrlKey || event.metaKey) && event.key === '\\') { event.preventDefault(); dispatch({ type: 'split-right' }); }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (project) openNewFileDialog(''); }
      if (event.shiftKey && event.key === 'F5') { event.preventDefault(); void resetExecution(); return; }
      if (event.key === 'F5') { event.preventDefault(); void runAnalysis(); }
      if (event.key === 'F6') { event.preventDefault(); void runExecution('diagnostics'); }
      if (event.key === 'F10') { event.preventDefault(); void stepExecution('diagnostics'); }
      if (event.key === 'F11') { event.preventDefault(); void toggleAutoStepExecution(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [buildActiveAssembly, openNewFileDialog, project, projects, resetExecution, runAnalysis, runExecution, stepExecution, toggleAutoStepExecution]);

  if (!project) {
    return <ProjectGate projects={projects.summaries} loading={projects.loading} onCreate={projects.createProject} onOpen={projects.openProject} onDelete={projects.deleteProject} />;
  }

  function createFile(path: string) {
    const file = projects.createTextFile(path);
    if (!file) return;
    dispatch({ type: 'open-file', fileId: file.id });
    setNewFileOpen(false);
    log(`Created ${file.path}.`, 'success');
  }

  return (
    <div className="app-shell">
      <MenuBar menus={menus} onSearch={(value) => { setSearchQuery(value); if (value) dispatch({ type: 'show-activity', activity: 'search' }); }} />
      <div className="app-body">
        <ActivityBar active={workspace.activeActivity} sidebarVisible={workspace.explorerVisible} onActivity={(activity) => dispatch({ type: 'set-activity', activity })} onSettings={() => setSettingsOpen(true)} />
        {workspace.explorerVisible ? (
          <>
            <div className="sidebar-resizable" style={{ width: `clamp(150px, ${workspace.sidebarWidth}px, 30vw)` }}>
              <ProjectExplorer
                project={project}
                activity={workspace.activeActivity}
                activeFileId={activeFile?.id ?? null}
                activeGraph={activeGraph}
                selectedNodeId={selectedNodeId}
                searchQuery={searchQuery}
                onOpenFile={(fileId) => dispatch({ type: 'open-file', fileId })}
                onNewFile={() => openNewFileDialog('')}
                onNewFileAt={openNewFileDialog}
                onSelectNode={selectOutlineNode}
                onRenameFile={renameFile}
                onMoveFile={moveFile}
                onDuplicateFile={duplicateFile}
                onDeleteFile={deleteFile}
                onRenameFolder={(folder, next) => projects.renameFolder(folder, next)}
                onDeleteFolder={deleteFolder}
              />
            </div>
            <ResizeHandle orientation="vertical" onDelta={(delta) => dispatch({ type: 'resize-sidebar', width: workspace.sidebarWidth + delta })} />
          </>
        ) : null}
        <main className="workbench">
          <div
            className="workbench-main"
            style={{ gridTemplateColumns: workspace.graphVisible ? `minmax(200px, 1fr) 4px minmax(340px, clamp(340px, ${workspace.analysisWidth}px, 58vw))` : 'minmax(0, 1fr)' }}
          >
            <EditorWorkspace
              project={project}
              groups={workspace.groups}
              activeGroupId={workspace.activeGroupId}
              fontSize={settings.fontSize}
              compactTabs={settings.compactTabs}
              revealTarget={revealTarget}
              executionSnapshot={execution.snapshot}
              problemsByFile={problemsByFile}
              onActivateGroup={(groupId) => dispatch({ type: 'activate-group', groupId })}
              onActivateFile={(groupId, fileId) => dispatch({ type: 'activate-file', groupId, fileId })}
              onCloseTab={(groupId, fileId) => dispatch({ type: 'close-tab', groupId, fileId })}
              onCloseGroup={(groupId) => dispatch({ type: 'close-group', groupId })}
              onChangeText={(fileId, text) => {
                const file = project.files.find((candidate) => candidate.id === fileId);
                projects.updateFileText(fileId, text);
                if (file?.language === 'asm' && file.kind === 'text') scheduleSourceAnalysis({ ...file, text, size: new TextEncoder().encode(text).byteLength, updatedAt: Date.now() }, text);
              }}
              onSplit={() => dispatch({ type: 'split-right' })}
            />
            {workspace.graphVisible ? <ResizeHandle orientation="vertical" onDelta={(delta) => dispatch({ type: 'resize-analysis', width: workspace.analysisWidth - delta })} /> : null}
            {workspace.graphVisible ? (
              <AnalysisDock
                graph={activeGraph}
                binarySummary={activeBinarySummary}
                grid={settings.graphGrid}
                labels={settings.graphLabels}
                selectedId={selectedNodeId}
                onSelect={setSelectedNodeId}
                onClearGraph={clearActiveGraph}
                analysisStale={activeProblems.some((problem) => problem.severity === 'error')}
                onNavigate={navigateFromNode}
                onSelectFunction={selectBinaryFunction}
                executionAddress={executionAddress}
                executionTrace={executionTrace}
              />
            ) : null}
          </div>
          {workspace.bottomPanelVisible ? <ResizeHandle orientation="horizontal" onDelta={(delta) => dispatch({ type: 'resize-bottom', height: workspace.bottomPanelHeight - delta })} /> : null}
          {workspace.bottomPanelVisible ? (
            <div className="bottom-panel-shell" style={{ height: workspace.bottomPanelHeight }}>
              <BottomPanel
                entries={output}
                problems={activeProblems}
                onSelectProblem={(problem) => { dispatch({ type: 'open-file', fileId: problem.fileId }); reveal(problem.fileId, { line: problem.line }); }}
                execution={execution.snapshot}
                executionSupport={activeExecutionSupport}
                executionTargetName={activeFile?.name ?? null}
                runtimeOutputChannel={runtimeOutputChannel}
                onTerminalCommand={executeTerminalCommand}
              />
            </div>
          ) : null}
        </main>
      </div>
      <StatusBar project={project} activeFile={activeFile} saveState={projects.saveState} capstoneStatus={capstoneStatus} nodeCount={activeGraph?.nodes.length ?? 0} />
      <input ref={fileInputRef} type="file" hidden multiple onChange={(event) => { void importFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
      <input ref={folderInputRef} type="file" hidden multiple onChange={(event) => { void importFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
      {settingsOpen ? <SettingsDialog settings={settings} globalDependencies={globalDependencies} onChange={setSettings} onClose={() => setSettingsOpen(false)} /> : null}
      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
      {newFileOpen ? <NewFileDialog initialPath={newFileInitialPath} onCreate={createFile} onClose={() => setNewFileOpen(false)} /> : null}
    </div>
  );
}
