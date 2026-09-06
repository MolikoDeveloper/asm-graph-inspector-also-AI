import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { analyzeAssembly } from '../features/analysis/asmParser';
import { analyzeBinary } from '../features/analysis/binaryAnalysis';
import type { AnalysisGraph } from '../features/analysis/model';
import { loadCapstone, type CapstoneStatus } from '../features/capstone/capstoneLoader';
import { importBrowserFile } from '../features/project/fileImport';
import { useProjectController } from '../features/project/useProjectController';
import type { ProjectFile } from '../features/project/model';
import { initialWorkspaceState } from '../features/workspace/model';
import { workspaceReducer } from '../features/workspace/workspaceReducer';
import { makeId } from '../shared/id';
import { useAppSettings } from './settings';
import { ActivityBar } from '../components/ActivityBar';
import { AboutDialog } from '../components/AboutDialog';
import { BottomPanel, type OutputEntry } from '../components/BottomPanel';
import { EditorWorkspace } from '../components/EditorWorkspace';
import { GraphPanel } from '../components/GraphPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { MenuBar, type MenuDefinition } from '../components/MenuBar';
import { NewFileDialog } from '../components/NewFileDialog';
import { ProjectExplorer } from '../components/ProjectExplorer';
import { ProjectGate } from '../components/ProjectGate';
import { SettingsDialog } from '../components/SettingsDialog';
import { StatusBar } from '../components/StatusBar';

export function App() {
  const projects = useProjectController();
  const { settings, setSettings } = useAppSettings();
  const [workspace, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [graphs, setGraphs] = useState<Map<string, AnalysisGraph>>(() => new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputEntry[]>([]);
  const [capstoneStatus, setCapstoneStatus] = useState<CapstoneStatus>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const lastProjectId = useRef<string | null>(null);

  const project = projects.project;
  const activeGroup = workspace.groups.find((group) => group.id === workspace.activeGroupId) ?? workspace.groups[0];
  const activeFile = project && activeGroup.activeFileId ? project.files.find((file) => file.id === activeGroup.activeFileId) ?? null : null;
  const activeGraph = activeFile ? graphs.get(activeFile.id) ?? null : null;

  const log = useCallback((message: string, level: OutputEntry['level'] = 'info') => {
    setOutput((entries) => [...entries.slice(-199), { id: makeId('log'), time: Date.now(), level, message }]);
  }, []);

  useEffect(() => {
    const id = project?.id ?? null;
    if (id === lastProjectId.current) return;
    lastProjectId.current = id;
    dispatch({ type: 'reset' });
    setGraphs(new Map());
    setSelectedNodeId(null);
    if (project) {
      const first = project.files[0];
      if (first) dispatch({ type: 'open-file', fileId: first.id });
      log(`Project loaded: ${project.name}`, 'success');
    }
  }, [project, log]);

  const runAnalysis = useCallback(async () => {
    if (!activeFile) {
      log('No active file to analyze.', 'error');
      return;
    }
    if (activeFile.kind === 'binary') {
      setCapstoneStatus('loading');
      log(`Parsing raw ELF and loading Capstone x86 for ${activeFile.name}…`);
      try {
        const result = await analyzeBinary(activeFile);
        setCapstoneStatus('ready');
        setGraphs((current) => {
          const next = new Map(current);
          next.set(activeFile.id, result.graph);
          return next;
        });
        setSelectedNodeId(result.graph.nodes[0]?.id ?? null);
        for (const diagnostic of result.graph.diagnostics) log(diagnostic, 'muted');
        log(`Analyzed ${activeFile.path}: ${result.summary.instructions.length} canonical instructions from raw ELF bytes.`, 'success');
      } catch (error: unknown) {
        setCapstoneStatus('error');
        log(`Binary analysis failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      return;
    }
    if (activeFile.language !== 'asm') {
      log(`${activeFile.name} is not an ASM source file.`, 'error');
      return;
    }
    const graph = analyzeAssembly(activeFile.id, activeFile.text ?? '');
    setGraphs((current) => {
      const next = new Map(current);
      next.set(activeFile.id, graph);
      return next;
    });
    setSelectedNodeId(graph.nodes[0]?.id ?? null);
    log(`Analyzed ${activeFile.path}: ${graph.nodes.length} nodes, ${graph.edges.length} edges.`, 'success');
  }, [activeFile, log]);

  const importFiles = useCallback(async (list: FileList | null) => {
    if (!project || !list?.length) return;
    const imported = await Promise.all([...list].map((file) => importBrowserFile(file)));
    projects.addFiles(imported);
    const first = imported[0];
    if (first) dispatch({ type: 'open-file', fileId: first.id });
    log(`Imported ${imported.length} file${imported.length === 1 ? '' : 's'} into ${project.name}.`, 'success');
  }, [project, projects, log]);

  const menus = useMemo<MenuDefinition[]>(() => [
    {
      label: 'Project',
      items: [
        { label: 'New / Switch Project…', action: projects.closeProject },
        { label: 'Save Project', shortcut: 'Ctrl S', action: () => void projects.saveNow() },
        { separator: true, label: '' },
        { label: 'Settings…', shortcut: 'Ctrl ,', action: () => setSettingsOpen(true) }
      ]
    },
    {
      label: 'File',
      items: [
        { label: 'New File…', shortcut: 'Ctrl N', action: () => setNewFileOpen(true) },
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
        { label: 'Toggle Graph', action: () => dispatch({ type: 'toggle-graph' }) },
        { label: 'Toggle Bottom Panel', shortcut: 'Ctrl J', action: () => dispatch({ type: 'toggle-bottom' }) },
        { separator: true, label: '' },
        { label: 'Split Editor Right', shortcut: 'Ctrl \\', action: () => dispatch({ type: 'split-right' }) }
      ]
    },
    {
      label: 'Analysis',
      items: [
        { label: 'Analyze Active File', shortcut: 'F5', action: runAnalysis },
        { label: 'Clear Active Graph', action: () => activeFile && setGraphs((current) => { const next = new Map(current); next.delete(activeFile.id); return next; }), disabled: !activeGraph }
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
  ], [activeFile, activeGraph, projects, runAnalysis, workspace.activeGroupId, log]);

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void projects.saveNow(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); dispatch({ type: 'toggle-explorer' }); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); dispatch({ type: 'toggle-bottom' }); }
      if ((event.ctrlKey || event.metaKey) && event.key === '\\') { event.preventDefault(); dispatch({ type: 'split-right' }); }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (project) setNewFileOpen(true); }
      if (event.key === 'F5') { event.preventDefault(); void runAnalysis(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [project, projects, runAnalysis]);

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
      <MenuBar menus={menus} onSearch={(value) => { setSearchQuery(value); if (value) dispatch({ type: 'set-activity', activity: 'search' }); }} />
      <div className="app-body">
        <ActivityBar active={workspace.activeActivity} onActivity={(activity) => dispatch({ type: 'set-activity', activity })} onSettings={() => setSettingsOpen(true)} />
        {workspace.explorerVisible ? <ProjectExplorer project={project} activity={workspace.activeActivity} activeFileId={activeFile?.id ?? null} searchQuery={searchQuery} onOpenFile={(fileId) => dispatch({ type: 'open-file', fileId })} onNewFile={() => setNewFileOpen(true)} /> : null}
        <main className="workbench">
          <div className="workbench-main">
            <EditorWorkspace
              project={project}
              groups={workspace.groups}
              activeGroupId={workspace.activeGroupId}
              fontSize={settings.fontSize}
              compactTabs={settings.compactTabs}
              onActivateGroup={(groupId) => dispatch({ type: 'activate-group', groupId })}
              onActivateFile={(groupId, fileId) => dispatch({ type: 'activate-file', groupId, fileId })}
              onCloseTab={(groupId, fileId) => dispatch({ type: 'close-tab', groupId, fileId })}
              onCloseGroup={(groupId) => dispatch({ type: 'close-group', groupId })}
              onChangeText={(fileId, text) => {
                projects.updateFileText(fileId, text);
                setGraphs((current) => { const next = new Map(current); next.delete(fileId); return next; });
              }}
              onSplit={() => dispatch({ type: 'split-right' })}
            />
            {workspace.graphVisible ? (
              <div className="analysis-dock">
                <GraphPanel graph={activeGraph} grid={settings.graphGrid} labels={settings.graphLabels} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
                <InspectorPanel graph={activeGraph} selectedId={selectedNodeId} />
              </div>
            ) : null}
          </div>
          {workspace.bottomPanelVisible ? <BottomPanel entries={output} /> : null}
        </main>
      </div>
      <StatusBar project={project} activeFile={activeFile} saveState={projects.saveState} capstoneStatus={capstoneStatus} nodeCount={activeGraph?.nodes.length ?? 0} />
      <input ref={fileInputRef} type="file" hidden multiple onChange={(event) => { void importFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
      <input ref={folderInputRef} type="file" hidden multiple onChange={(event) => { void importFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
      {settingsOpen ? <SettingsDialog settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} /> : null}
      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
      {newFileOpen ? <NewFileDialog onCreate={createFile} onClose={() => setNewFileOpen(false)} /> : null}
    </div>
  );
}
