import { useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import { Modal } from './ui';

export function NewFileDialog({ onCreate, onClose }: { onCreate(path: string): void; onClose(): void }) {
  const [path, setPath] = useState('src/new.asm');
  function submit() {
    if (!path.trim()) return;
    onCreate(path);
  }
  return (
    <Modal title="New file" onClose={onClose} width={520}>
      <div className="new-file-dialog">
        <FilePlus2 size={24} />
        <p>Files are created inside the current browser-local project.</p>
        <label className="field-label" htmlFor="new-file-path">Project path</label>
        <input id="new-file-path" className="text-input" autoFocus value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} />
        <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={submit}>Create file</button></div>
      </div>
    </Modal>
  );
}
