import { useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { Binary, ChevronDown, ChevronRight, File, Folder, FolderOpen, GitBranch, Plus, Search } from 'lucide-react';
import type { AnalysisGraph } from '../features/analysis/model';
import type { InspectorProject, ProjectFile } from '../features/project/model';
import type { WorkspaceState } from '../features/workspace/model';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { PathOperationDialog } from './PathOperationDialog';

interface TreeDirectory { name: string; path: string; directories: Map<string, TreeDirectory>; files: ProjectFile[]; }
interface ContextTarget { kind: 'file' | 'folder' | 'root'; x: number; y: number; file?: ProjectFile; path?: string; }
interface PathDialogState { kind: 'rename-file' | 'move-file' | 'duplicate-file' | 'rename-folder'; file?: ProjectFile; folderPath?: string; initialValue: string; }

function buildTree(files: ProjectFile[]): TreeDirectory {
  const root: TreeDirectory = { name: '', path: '', directories: new Map(), files: [] };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split('/').filter(Boolean);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      const path = current.path ? `${current.path}/${part}` : part;
      let next = current.directories.get(part);
      if (!next) {
        next = { name: part, path, directories: new Map(), files: [] };
        current.directories.set(part, next);
      }
      current = next;
    }
    current.files.push(file);
  }
  return root;
}

function directoryOf(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

function duplicatePath(file: ProjectFile): string {
  const directory = directoryOf(file.path);
  const dot = file.name.lastIndexOf('.');
  const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  const extension = dot > 0 ? file.name.slice(dot) : '';
  return `${directory ? `${directory}/` : ''}${stem}.copy${extension}`;
}

function FileNode({ file, active, onOpen, onContext, onDragStart }: {
  file: ProjectFile;
  active: boolean;
  onOpen(fileId: string): void;
  onContext(event: MouseEvent, file: ProjectFile): void;
  onDragStart(event: DragEvent, file: ProjectFile): void;
}) {
  const Icon = file.kind === 'binary' ? Binary : File;
  return (
    <button
      className={active ? 'tree-row tree-file active' : 'tree-row tree-file'}
      onClick={() => onOpen(file.id)}
      onContextMenu={(event) => onContext(event, file)}
      draggable
      onDragStart={(event) => onDragStart(event, file)}
      title={file.path}
    >
      <span className="tree-spacer" /><Icon size={14} /><span>{file.name}</span>
    </button>
  );
}

function DirectoryNode({ directory, activeFileId, onOpen, onContextFile, onContextFolder, onMoveFile, onDragStart }: {
  directory: TreeDirectory;
  activeFileId: string | null;
  onOpen(fileId: string): void;
  onContextFile(event: MouseEvent, file: ProjectFile): void;
  onContextFolder(event: MouseEvent, path: string): void;
  onMoveFile(fileId: string, destinationDirectory: string): void;
  onDragStart(event: DragEvent, file: ProjectFile): void;
}) {
  const [open, setOpen] = useState(true);
  const [dropTarget, setDropTarget] = useState(false);
  return (
    <div className="tree-directory">
      <button
        className={dropTarget ? 'tree-row tree-folder drop-target' : 'tree-row tree-folder'}
        onClick={() => setOpen((value) => !value)}
        onContextMenu={(event) => onContextFolder(event, directory.path)}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-asmgraph-file')) { event.preventDefault(); setDropTarget(true); } }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropTarget(false);
          const fileId = event.dataTransfer.getData('application/x-asmgraph-file');
          if (fileId) onMoveFile(fileId, directory.path);
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{directory.name}</span>
      </button>
      {open ? <div className="tree-children">
        {[...directory.directories.values()].map((child) => <DirectoryNode key={child.path} directory={child} activeFileId={activeFileId} onOpen={onOpen} onContextFile={onContextFile} onContextFolder={onContextFolder} onMoveFile={onMoveFile} onDragStart={onDragStart} />)}
        {directory.files.map((file) => <FileNode key={file.id} file={file} active={file.id === activeFileId} onOpen={onOpen} onContext={onContextFile} onDragStart={onDragStart} />)}
      </div> : null}
    </div>
  );
}

export function ProjectExplorer({
  project,
  activity,
  activeFileId,
  activeGraph,
  selectedNodeId,
  searchQuery,
  onOpenFile,
  onNewFile,
  onNewFileAt,
  onSelectNode,
  onRenameFile,
  onMoveFile,
  onDuplicateFile,
  onDeleteFile,
  onRenameFolder,
  onDeleteFolder
}: {
  project: InspectorProject;
  activity: WorkspaceState['activeActivity'];
  activeFileId: string | null;
  activeGraph: AnalysisGraph | null;
  selectedNodeId: string | null;
  searchQuery: string;
  onOpenFile(fileId: string): void;
  onNewFile(): void;
  onNewFileAt(directory: string): void;
  onSelectNode(id: string): void;
  onRenameFile(fileId: string, path: string): void;
  onMoveFile(fileId: string, destinationDirectory: string): void;
  onDuplicateFile(fileId: string, path: string): void;
  onDeleteFile(fileId: string): void;
  onRenameFolder(folderPath: string, nextPath: string): void;
  onDeleteFolder(folderPath: string): void;
}) {
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [binariesOpen, setBinariesOpen] = useState(false);
  const [context, setContext] = useState<ContextTarget | null>(null);
  const [pathDialog, setPathDialog] = useState<PathDialogState | null>(null);
  const [rootDropTarget, setRootDropTarget] = useState(false);
  const tree = useMemo(() => buildTree(project.files), [project.files]);
  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return project.files;
    return project.files.filter((file) => file.path.toLowerCase().includes(query) || file.text?.toLowerCase().includes(query));
  }, [project.files, searchQuery]);
  const binaries = useMemo(() => project.files.filter((file) => file.kind === 'binary').sort((left, right) => left.path.localeCompare(right.path)), [project.files]);
  const outline = useMemo(() => {
    if (!activeGraph) return [];
    if (activeGraph.viewKind === 'function-cfg') return activeGraph.nodes.filter((node) => node.blockInstructions?.length).map((node) => ({ id: node.id, title: node.title, detail: node.detail }));
    return activeGraph.nodes.filter((node) => node.kind === 'label').map((node) => ({ id: node.id, title: node.title, detail: node.line ? `line ${node.line}` : node.detail }));
  }, [activeGraph]);

  const showFileContext = (event: MouseEvent, file: ProjectFile) => {
    event.preventDefault();
    event.stopPropagation();
    setContext({ kind: 'file', x: event.clientX, y: event.clientY, file });
  };
  const showFolderContext = (event: MouseEvent, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContext({ kind: 'folder', x: event.clientX, y: event.clientY, path });
  };
  const dragStart = (event: DragEvent, file: ProjectFile) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-asmgraph-file', file.id);
    event.dataTransfer.setData('text/plain', file.path);
  };

  const contextItems = useMemo<ContextMenuItem[]>(() => {
    if (!context) return [];
    if (context.kind === 'file' && context.file) {
      const file = context.file;
      return [
        { label: 'Open', action: () => onOpenFile(file.id) },
        { label: 'Rename…', action: () => setPathDialog({ kind: 'rename-file', file, initialValue: file.path }) },
        { label: 'Move to…', action: () => setPathDialog({ kind: 'move-file', file, initialValue: directoryOf(file.path) }) },
        { label: 'Duplicate…', action: () => setPathDialog({ kind: 'duplicate-file', file, initialValue: duplicatePath(file) }) },
        { label: 'Delete', danger: true, separatorBefore: true, action: () => { if (window.confirm(`Delete ${file.path} from this project?`)) onDeleteFile(file.id); } }
      ];
    }
    if (context.kind === 'folder' && context.path) {
      const path = context.path;
      return [
        { label: 'New file here…', action: () => onNewFileAt(path) },
        { label: 'Rename / Move folder…', action: () => setPathDialog({ kind: 'rename-folder', folderPath: path, initialValue: path }) },
        { label: 'Delete folder', danger: true, separatorBefore: true, action: () => { if (window.confirm(`Delete every project file under ${path}/?`)) onDeleteFolder(path); } }
      ];
    }
    return [{ label: 'New file…', action: onNewFile }];
  }, [context, onDeleteFile, onDeleteFolder, onNewFile, onNewFileAt, onOpenFile]);

  return (
    <aside className="sidebar">
      <header className="sidebar-header"><span>{activity === 'explorer' ? 'EXPLORER' : 'SEARCH'}</span><button className="sidebar-action" title="New file" onClick={onNewFile}><Plus size={15} /></button></header>
      {activity === 'explorer' ? (
        <>
          <div
            className={rootDropTarget ? 'project-root drop-target' : 'project-root'}
            onContextMenu={(event) => { event.preventDefault(); setContext({ kind: 'root', x: event.clientX, y: event.clientY }); }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-asmgraph-file')) { event.preventDefault(); setRootDropTarget(true); } }}
            onDragLeave={() => setRootDropTarget(false)}
            onDrop={(event) => { event.preventDefault(); setRootDropTarget(false); const fileId = event.dataTransfer.getData('application/x-asmgraph-file'); if (fileId) onMoveFile(fileId, ''); }}
          ><ChevronDown size={13} /><strong>{project.name}</strong></div>
          <div className="project-tree">
            {[...tree.directories.values()].map((directory) => <DirectoryNode key={directory.path} directory={directory} activeFileId={activeFileId} onOpen={onOpenFile} onContextFile={showFileContext} onContextFolder={showFolderContext} onMoveFile={onMoveFile} onDragStart={dragStart} />)}
            {tree.files.map((file) => <FileNode key={file.id} file={file} active={file.id === activeFileId} onOpen={onOpenFile} onContext={showFileContext} onDragStart={dragStart} />)}
          </div>
          <div className="sidebar-section">
            <button onClick={() => setOutlineOpen((value) => !value)}>{outlineOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<GitBranch size={13} />OUTLINE<span className="sidebar-section-count">{outline.length}</span></button>
            {outlineOpen ? <div className="sidebar-section-body">{outline.length ? outline.slice(0, 400).map((item) => <button key={item.id} className={item.id === selectedNodeId ? 'active' : ''} onClick={() => onSelectNode(item.id)}><span>{item.title}</span><small>{item.detail}</small></button>) : <p>Analysis updates automatically when the active ASM is valid.</p>}</div> : null}
          </div>
          <div className="sidebar-section">
            <button onClick={() => setBinariesOpen((value) => !value)}>{binariesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Binary size={13} />BINARIES<span className="sidebar-section-count">{binaries.length}</span></button>
            {binariesOpen ? <div className="sidebar-section-body">{binaries.length ? binaries.map((file) => <button key={file.id} className={file.id === activeFileId ? 'active' : ''} onClick={() => onOpenFile(file.id)}><span>{file.name}</span><small>{file.path}</small></button>) : <p>No binary artifacts are stored in this project.</p>}</div> : null}
          </div>
        </>
      ) : null}
      {activity === 'search' ? (
        <div className="sidebar-search-results">
          <div className="sidebar-search-title"><Search size={14} /><span>{searchQuery ? `Results for “${searchQuery}”` : 'Type in the top search field'}</span></div>
          {filtered.slice(0, 60).map((file) => <button key={file.id} onClick={() => onOpenFile(file.id)}><strong>{file.name}</strong><span>{file.path}</span></button>)}
        </div>
      ) : null}
      {context ? <ContextMenu x={context.x} y={context.y} items={contextItems} onClose={() => setContext(null)} /> : null}
      {pathDialog ? (
        <PathOperationDialog
          title={pathDialog.kind === 'rename-file' ? 'Rename file' : pathDialog.kind === 'move-file' ? 'Move file' : pathDialog.kind === 'duplicate-file' ? 'Duplicate file' : 'Rename / move folder'}
          description={pathDialog.kind === 'move-file' ? 'Enter the destination directory inside this project. The file name is preserved.' : 'Enter the new project-relative path.'}
          initialValue={pathDialog.initialValue}
          confirmLabel={pathDialog.kind === 'duplicate-file' ? 'Duplicate' : pathDialog.kind === 'move-file' ? 'Move' : 'Apply'}
          onClose={() => setPathDialog(null)}
          onConfirm={(value) => {
            if (pathDialog.kind === 'rename-file' && pathDialog.file) onRenameFile(pathDialog.file.id, value);
            if (pathDialog.kind === 'move-file' && pathDialog.file) onMoveFile(pathDialog.file.id, value);
            if (pathDialog.kind === 'duplicate-file' && pathDialog.file) onDuplicateFile(pathDialog.file.id, value);
            if (pathDialog.kind === 'rename-folder' && pathDialog.folderPath) onRenameFolder(pathDialog.folderPath, value);
            setPathDialog(null);
          }}
        />
      ) : null}
    </aside>
  );
}
