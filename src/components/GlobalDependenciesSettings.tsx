import { useRef } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import type { GlobalDependencyController } from '../features/dependencies/useGlobalDependencies';
import { IconButton } from './ui';

export function GlobalDependenciesSettings({ controller }: { controller: GlobalDependencyController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="settings-section-heading">
        <div>
          <h3>Global dependencies</h3>
          <p className="settings-copy">Libraries and authorized library folders listed here are shared by every project in this browser. ELF <code>DT_NEEDED</code> entries are resolved against this registry automatically.</p>
        </div>
        <div className="settings-actions">
          <button className="secondary-button" onClick={() => inputRef.current?.click()}><Plus size={14} />Add libraries…</button>
          <button className="secondary-button" disabled={!controller.directoryPickerSupported} onClick={() => void controller.addDirectory()}><FolderOpen size={14} />Add library folder…</button>
        </div>
      </div>
      <input ref={inputRef} type="file" hidden multiple onChange={(event) => { if (event.currentTarget.files?.length) void controller.addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
      {controller.error ? <div className="dependency-error">{controller.error}</div> : null}
      {!controller.directoryPickerSupported ? <div className="dependency-notice">Directory authorization is unavailable in this browser. Imported library files still work globally.</div> : null}
      <div className="dependency-list">
        {controller.loading ? <div className="dependency-empty">Loading global dependencies…</div> : null}
        {!controller.loading && !controller.entries.length ? <div className="dependency-empty">No global dependencies configured. Import `.so` files or authorize one or more system library directories.</div> : null}
        {controller.entries.map((entry) => (
          <div className="dependency-row" key={entry.id}>
            <span className={entry.kind === 'file' ? 'dependency-kind file' : 'dependency-kind directory'}>{entry.kind === 'file' ? 'ELF' : 'DIR'}</span>
            <div className="dependency-main">
              <strong>{entry.name}</strong>
              {entry.kind === 'file' ? <small>{entry.soname ? `SONAME ${entry.soname}` : 'Imported library file'} · {entry.size.toLocaleString()} bytes</small> : <small>Authorized host library root · shared by all projects</small>}
            </div>
            {entry.kind === 'directory' ? <button className="dependency-permission" onClick={() => void controller.requestPermission(entry.id)}>Reconnect</button> : null}
            <IconButton title={`Remove ${entry.name}`} aria-label={`Remove ${entry.name}`} onClick={() => void controller.remove(entry.id)}><X size={14} /></IconButton>
          </div>
        ))}
      </div>
      <div className="dependency-help">
        <strong>Resolution order</strong>
        <span>1. Imported global ELF by exact <code>DT_SONAME</code>.</span>
        <span>2. Imported global ELF by filename.</span>
        <span>3. Exact filename inside authorized global library folders.</span>
        <span>Unresolved dependencies remain external; the inspector never guesses a different library.</span>
      </div>
    </>
  );
}
