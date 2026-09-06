import { useMemo, useState } from 'react';
import { Boxes, FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { ProjectSummary } from '../features/project/model';
import { Modal } from './ui';

interface ProjectGateProps {
  projects: ProjectSummary[];
  loading: boolean;
  onCreate(name: string, withSample: boolean): Promise<void>;
  onOpen(id: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}

export function ProjectGate({ projects, loading, onCreate, onOpen, onDelete }: ProjectGateProps) {
  const [name, setName] = useState('asm-project');
  const [withSample, setWithSample] = useState(true);
  const [creating, setCreating] = useState(false);
  const sorted = useMemo(() => [...projects].sort((a, b) => b.updatedAt - a.updatedAt), [projects]);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await onCreate(name, withSample);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title="Open a project" width={820}>
      <div className="project-gate-grid">
        <div className="project-create-panel">
          <div className="project-mark"><Boxes size={28} /></div>
          <h3>Everything lives inside a project</h3>
          <p>Files, analysis state, graph settings and imported binaries stay scoped to a browser-local project.</p>
          <label className="field-label" htmlFor="project-name">Project name</label>
          <input id="project-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create(); }} />
          <label className="check-row">
            <input type="checkbox" checked={withSample} onChange={(event) => setWithSample(event.target.checked)} />
            Add a small NASM sample
          </label>
          <button className="primary-button" onClick={() => void create()} disabled={creating || !name.trim()}>
            <Plus size={16} /> {creating ? 'Creating…' : 'Create project'}
          </button>
        </div>
        <div className="recent-projects-panel">
          <div className="section-heading"><FolderOpen size={16} /><span>Recent projects</span></div>
          {loading ? <div className="project-loading">Loading local projects…</div> : null}
          {!loading && sorted.length === 0 ? <div className="project-loading">No saved projects yet.</div> : null}
          <div className="recent-list">
            {sorted.map((project) => (
              <div className="recent-project" key={project.id}>
                <button className="recent-project-main" onClick={() => void onOpen(project.id)}>
                  <strong>{project.name}</strong>
                  <span>{project.fileCount} files · {new Date(project.updatedAt).toLocaleString()}</span>
                </button>
                <button className="recent-delete" aria-label={`Delete ${project.name}`} onClick={() => void onDelete(project.id)}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
