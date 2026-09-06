import { useState } from 'react';
import { Cpu, FolderOpen, Grid2X2, SlidersHorizontal, Type } from 'lucide-react';
import type { AppSettings } from '../app/settings';
import type { GlobalDependencyController } from '../features/dependencies/useGlobalDependencies';
import { GlobalDependenciesSettings } from './GlobalDependenciesSettings';
import { Modal } from './ui';

export function SettingsDialog({ settings, globalDependencies, onChange, onClose }: { settings: AppSettings; globalDependencies: GlobalDependencyController; onChange(next: AppSettings): void; onClose(): void }) {
  const [tab, setTab] = useState<'general' | 'editor' | 'graph' | 'dependencies' | 'runtime'>('general');
  const tabs = [
    ['general', 'General', SlidersHorizontal],
    ['editor', 'Editor', Type],
    ['graph', 'Graph', Grid2X2],
    ['dependencies', 'Global dependencies', FolderOpen],
    ['runtime', 'Runtime', Cpu]
  ] as const;

  return (
    <Modal title="Settings" onClose={onClose} width={900}>
      <div className="settings-layout">
        <nav className="settings-nav">
          {tabs.map(([id, label, Icon]) => (
            <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'general' ? (
            <>
              <h3>General</h3>
              <p className="settings-copy">Application shell preferences are stored locally and never leave the browser.</p>
              <label className="setting-row"><span><strong>Theme</strong><small>Dark chrome for long analysis sessions.</small></span><select value={settings.theme} onChange={(event) => onChange({ ...settings, theme: event.target.value as AppSettings['theme'] })}><option value="dark">Dark</option><option value="darker">Darker</option></select></label>
              <label className="setting-row"><span><strong>Compact tabs</strong><small>Reduce tab height when many files are open.</small></span><input type="checkbox" checked={settings.compactTabs} onChange={(event) => onChange({ ...settings, compactTabs: event.target.checked })} /></label>
            </>
          ) : null}
          {tab === 'editor' ? (
            <>
              <h3>Editor</h3>
              <label className="setting-row"><span><strong>Font size</strong><small>Source editor and line-number size.</small></span><input type="range" min="11" max="20" step="1" value={settings.fontSize} onChange={(event) => onChange({ ...settings, fontSize: Number(event.target.value) })} /><output>{settings.fontSize}px</output></label>
            </>
          ) : null}
          {tab === 'graph' ? (
            <>
              <h3>Graph</h3>
              <label className="setting-row"><span><strong>Canvas grid</strong><small>Draw a subtle spatial grid behind graph nodes.</small></span><input type="checkbox" checked={settings.graphGrid} onChange={(event) => onChange({ ...settings, graphGrid: event.target.checked })} /></label>
              <label className="setting-row"><span><strong>Edge labels</strong><small>Show branch/call labels when available.</small></span><input type="checkbox" checked={settings.graphLabels} onChange={(event) => onChange({ ...settings, graphLabels: event.target.checked })} /></label>
            </>
          ) : null}
          {tab === 'dependencies' ? <GlobalDependenciesSettings controller={globalDependencies} /> : null}
          {tab === 'runtime' ? (
            <>
              <h3>Runtime</h3>
              <p className="settings-copy">Capstone is now a separate static asset and is loaded only when binary analysis requests it.</p>
              <div className="runtime-path"><span>JS</span><code>public/vendor/capstone/capstone_x86.js</code></div>
              <div className="runtime-path"><span>WASM</span><code>public/vendor/capstone/capstone_x86.wasm</code></div>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
