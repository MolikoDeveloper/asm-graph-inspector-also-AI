import { useMemo, useState } from 'react';
import { Binary, ChevronDown, ChevronRight, File, Folder, FolderOpen, GitBranch, Plus, Search } from 'lucide-react';
import type { InspectorProject, ProjectFile } from '../features/project/model';
import type { WorkspaceState } from '../features/workspace/model';

interface TreeDirectory { name: string; path: string; directories: Map<string, TreeDirectory>; files: ProjectFile[]; }

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

function DirectoryNode({ directory, activeFileId, onOpen }: { directory: TreeDirectory; activeFileId: string | null; onOpen(fileId: string): void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="tree-directory">
      <button className="tree-row tree-folder" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{directory.name}</span>
      </button>
      {open ? <div className="tree-children">
        {[...directory.directories.values()].map((child) => <DirectoryNode key={child.path} directory={child} activeFileId={activeFileId} onOpen={onOpen} />)}
        {directory.files.map((file) => <FileNode key={file.id} file={file} active={file.id === activeFileId} onOpen={onOpen} />)}
      </div> : null}
    </div>
  );
}

function FileNode({ file, active, onOpen }: { file: ProjectFile; active: boolean; onOpen(fileId: string): void }) {
  const Icon = file.kind === 'binary' ? Binary : File;
  return <button className={active ? 'tree-row tree-file active' : 'tree-row tree-file'} onClick={() => onOpen(file.id)} title={file.path}><span className="tree-spacer" /><Icon size={14} /><span>{file.name}</span></button>;
}

export function ProjectExplorer({ project, activity, activeFileId, searchQuery, onOpenFile, onNewFile }: { project: InspectorProject; activity: WorkspaceState['activeActivity']; activeFileId: string | null; searchQuery: string; onOpenFile(fileId: string): void; onNewFile(): void }) {
  const tree = useMemo(() => buildTree(project.files), [project.files]);
  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return project.files;
    return project.files.filter((file) => file.path.toLowerCase().includes(query) || file.text?.toLowerCase().includes(query));
  }, [project.files, searchQuery]);

  return (
    <aside className="sidebar">
      <header className="sidebar-header"><span>{activity === 'explorer' ? 'EXPLORER' : activity === 'search' ? 'SEARCH' : 'ANALYSIS'}</span><button className="sidebar-action" title="New file" onClick={onNewFile}><Plus size={15} /></button></header>
      {activity === 'explorer' ? (
        <>
          <div className="project-root"><ChevronDown size={13} /><strong>{project.name}</strong></div>
          <div className="project-tree">
            {[...tree.directories.values()].map((directory) => <DirectoryNode key={directory.path} directory={directory} activeFileId={activeFileId} onOpen={onOpenFile} />)}
            {tree.files.map((file) => <FileNode key={file.id} file={file} active={file.id === activeFileId} onOpen={onOpenFile} />)}
          </div>
          <div className="sidebar-section"><button><ChevronRight size={13} /><GitBranch size={13} />OUTLINE</button></div>
          <div className="sidebar-section"><button><ChevronRight size={13} /><Binary size={13} />BINARIES</button></div>
        </>
      ) : null}
      {activity === 'search' ? (
        <div className="sidebar-search-results">
          <div className="sidebar-search-title"><Search size={14} /><span>{searchQuery ? `Results for “${searchQuery}”` : 'Type in the top search field'}</span></div>
          {filtered.slice(0, 60).map((file) => <button key={file.id} onClick={() => onOpenFile(file.id)}><strong>{file.name}</strong><span>{file.path}</span></button>)}
        </div>
      ) : null}
      {activity === 'analysis' ? (
        <div className="analysis-sidebar">
          <h3>Workspace analysis</h3>
          <dl><div><dt>Files</dt><dd>{project.files.length}</dd></div><div><dt>ASM</dt><dd>{project.files.filter((file) => file.language === 'asm').length}</dd></div><div><dt>Binaries</dt><dd>{project.files.filter((file) => file.kind === 'binary').length}</dd></div></dl>
          <p>Select an ASM or binary file, then run Analysis from the top menu.</p>
        </div>
      ) : null}
    </aside>
  );
}
