import { CheckCircle2, Cpu, FileCode2, Save } from 'lucide-react';
import type { InspectorProject, ProjectFile } from '../features/project/model';
import type { CapstoneStatus } from '../features/capstone/capstoneLoader';

export function StatusBar({ project, activeFile, saveState, capstoneStatus, nodeCount }: { project: InspectorProject; activeFile: ProjectFile | null; saveState: 'saved' | 'dirty' | 'saving' | 'error'; capstoneStatus: CapstoneStatus; nodeCount: number }) {
  return (
    <footer className="status-bar">
      <div className="status-left"><span><CheckCircle2 size={13} /> {project.name}</span><span><Save size={13} /> {saveState}</span></div>
      <div className="status-right"><span><Cpu size={13} /> Capstone: {capstoneStatus}</span><span><FileCode2 size={13} /> {activeFile?.name ?? 'No file'}</span><span>Nodes: {nodeCount}</span><span>Ready</span></div>
    </footer>
  );
}
