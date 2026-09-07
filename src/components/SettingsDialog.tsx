import { useState } from 'react';
import { Binary, Boxes, Cpu, FolderOpen, Gauge, Grid2X2, LoaderCircle, Play, SlidersHorizontal, Type } from 'lucide-react';
import type { AppSettings } from '../app/settings';
import { currentCapstone, loadCapstone } from '../features/capstone/capstoneLoader';
import type { GlobalDependencyController } from '../features/dependencies/useGlobalDependencies';
import { currentUnicornCapabilityReport, probeUnicornX86Capabilities, type UnicornCapabilityReport } from '../features/execution/unicornCapabilities';
import { currentUnicornX86, loadUnicornX86 } from '../features/execution/unicornLoader';
import { GlobalDependenciesSettings } from './GlobalDependenciesSettings';
import './SettingsDialog.css';
import { Modal } from './ui';

type SettingsTab = 'general' | 'editor' | 'graph' | 'dependencies' | 'runtime';

function RuntimeBadge({ state, children }: { state: 'ready' | 'lazy' | 'warning' | 'error'; children: React.ReactNode }) {
  return <span className={`runtime-badge ${state}`}>{children}</span>;
}

export function SettingsDialog({ settings, globalDependencies, onChange, onClose }: { settings: AppSettings; globalDependencies: GlobalDependencyController; onChange(next: AppSettings): void; onClose(): void }) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [capstoneLoaded, setCapstoneLoaded] = useState(() => currentCapstone() !== null);
  const [capstoneBusy, setCapstoneBusy] = useState(false);
  const [capstoneError, setCapstoneError] = useState<string | null>(null);
  const [unicornLoaded, setUnicornLoaded] = useState(() => currentUnicornX86() !== null);
  const [unicornBusy, setUnicornBusy] = useState(false);
  const [unicornError, setUnicornError] = useState<string | null>(null);
  const [unicornReport, setUnicornReport] = useState<UnicornCapabilityReport | null>(() => currentUnicornCapabilityReport());
  const tabs = [
    ['general', 'General', SlidersHorizontal],
    ['editor', 'Editor', Type],
    ['graph', 'Graph', Grid2X2],
    ['dependencies', 'Global dependencies', FolderOpen],
    ['runtime', 'Runtime', Cpu]
  ] as const;

  const loadAnalysisRuntime = async () => {
    setCapstoneBusy(true);
    setCapstoneError(null);
    try {
      await loadCapstone();
      setCapstoneLoaded(true);
    } catch (cause) {
      setCapstoneError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCapstoneBusy(false);
    }
  };

  const probeUnicornRuntime = async () => {
    setUnicornBusy(true);
    setUnicornError(null);
    try {
      await loadUnicornX86();
      setUnicornLoaded(true);
      setUnicornReport(await probeUnicornX86Capabilities(true));
    } catch (cause) {
      setUnicornError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUnicornBusy(false);
    }
  };

  return (
    <Modal title="Settings" onClose={onClose} width={960}>
      <div className="settings-layout">
        <nav className="settings-nav">
          {tabs.map(([id, label, Icon]) => (
            <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'general' ? (
            <>
              <div className="settings-section-heading"><h2>General</h2><p>The inspector is browser-local. Projects, UI preferences and generated build artifacts are persisted by the application storage model; there is no Git repository, branch, shell account or host filesystem implied by this workspace.</p></div>
              <label className="setting-row"><span><strong>Theme</strong><small>Dark chrome for long binary-analysis sessions.</small></span><select value={settings.theme} onChange={(event) => onChange({ ...settings, theme: event.target.value as AppSettings['theme'] })}><option value="dark">Dark</option><option value="darker">Darker</option></select></label>
              <label className="setting-row"><span><strong>Compact tabs</strong><small>Reduce tab height when many source, ELF or dump files are open.</small></span><input type="checkbox" checked={settings.compactTabs} onChange={(event) => onChange({ ...settings, compactTabs: event.target.checked })} /></label>
              <div className="settings-note-card"><strong>Virtual console contract.</strong> The bottom prompt is an Inspector command surface, not bash/zsh. A direct project ELF path can be executed, while objdump/disassembly files are opened as analysis evidence.</div>
            </>
          ) : null}
          {tab === 'editor' ? (
            <>
              <div className="settings-section-heading"><h2>Editor</h2><p>Source and disassembly presentation. Binary instruction truth continues to come from ELF bytes decoded by Capstone.</p></div>
              <label className="setting-row"><span><strong>Font size</strong><small>Source editor and line-number size.</small></span><input type="range" min="11" max="20" step="1" value={settings.fontSize} onChange={(event) => onChange({ ...settings, fontSize: Number(event.target.value) })} /><output>{settings.fontSize}px</output></label>
            </>
          ) : null}
          {tab === 'graph' ? (
            <>
              <div className="settings-section-heading"><h2>Graph</h2><p>CFG, program-flow, binary-structure and dataflow rendering. Selection is inspection-only: a click highlights direct and transitive paths without moving the viewport; double-click drills into a deeper view when one exists.</p></div>
              <label className="setting-row"><span><strong>Canvas grid</strong><small>Draw a subtle spatial grid behind graph nodes.</small></span><input type="checkbox" checked={settings.graphGrid} onChange={(event) => onChange({ ...settings, graphGrid: event.target.checked })} /></label>
              <label className="setting-row"><span><strong>Edge labels</strong><small>Show branch, call and loop labels when available.</small></span><input type="checkbox" checked={settings.graphLabels} onChange={(event) => onChange({ ...settings, graphLabels: event.target.checked })} /></label>
              <div className="settings-note-card"><strong>Current graph behavior.</strong> The minimap is always available, execution-follow may center the observed RIP, and CFG back-edges use obstacle-aware outer lanes so loops do not pass through sibling basic-block cards.</div>
            </>
          ) : null}
          {tab === 'dependencies' ? <GlobalDependenciesSettings controller={globalDependencies} /> : null}
          {tab === 'runtime' ? (
            <>
              <div className="settings-section-heading"><h2>Runtime</h2><p>Execution routing is artifact-derived. The inspector does not ask which compiler produced a binary: it selects a backend from the ELF shape and the runtime services that artifact actually needs.</p></div>

              <h3>Execution routing</h3>
              <div className="runtime-routing-grid">
                <article className="runtime-route-card"><header><Gauge size={15} /><strong>Static x86-64 ET_EXEC</strong><RuntimeBadge state="ready">Unicorn</RuntimeBadge></header><p>Fixed-address ELF without <code>PT_INTERP</code>/<code>DT_NEEDED</code> executes on Unicorn/WASM. Step snapshots are decoded by Capstone and projected back onto Disassembly + CFG.</p></article>
                <article className="runtime-route-card"><header><Boxes size={15} /><strong>Dynamic Linux ELF</strong><RuntimeBadge state="ready">Blink</RuntimeBadge></header><p>PIE, <code>PT_INTERP</code> or <code>DT_NEEDED</code> still use Blink while the Unicorn Linux-userspace layer grows. Loader and recursive shared libraries come from Global Dependencies.</p></article>
              </div>

              <h3>Engines</h3>
              <div className="runtime-engine-grid">
                <article className="runtime-engine-card">
                  <header><Binary size={15} /><strong>Capstone x86</strong><RuntimeBadge state={capstoneError ? 'error' : capstoneLoaded ? 'ready' : 'lazy'}>{capstoneError ? 'error' : capstoneLoaded ? 'loaded' : 'lazy'}</RuntimeBadge></header>
                  <p>Canonical x86-64 decoder for ELF disassembly, CFG/dataflow evidence and execution-follow. It never executes guest code.</p>
                  <div className="runtime-asset-list"><div><span>JS</span><code>vendor/capstone/capstone_x86.js</code></div><div><span>WASM</span><code>vendor/capstone/capstone_x86.wasm</code></div></div>
                  <div className="runtime-engine-actions"><button disabled={capstoneBusy || capstoneLoaded} onClick={() => void loadAnalysisRuntime()}>{capstoneBusy ? 'Loading…' : capstoneLoaded ? 'Loaded' : 'Load now'}</button></div>
                  {capstoneError ? <p className="runtime-engine-error">{capstoneError}</p> : null}
                </article>

                <article className="runtime-engine-card">
                  <header><Cpu size={15} /><strong>Unicorn x86/WASM</strong><RuntimeBadge state={unicornError ? 'error' : unicornLoaded ? 'ready' : 'lazy'}>{unicornError ? 'error' : unicornLoaded ? 'loaded' : 'lazy'}</RuntimeBadge></header>
                  <p>CPU + memory execution backend for static ELF. ISA capabilities below are measured by executing real instruction bytes inside this exact vendored runtime rather than inferred from metadata.</p>
                  <div className="runtime-asset-list"><div><span>Runtime</span><code>vendor/unicorn/unicorn_x86.js</code></div><div><span>Build</span><code>@alexaltea/unicorn-js 2.1.4 · x86-only SINGLE_FILE</code></div></div>
                  <div className="runtime-engine-actions"><button disabled={unicornBusy} onClick={() => void probeUnicornRuntime()}>{unicornBusy ? <><LoaderCircle size={11} /> Probing…</> : unicornReport ? 'Re-run capability probes' : 'Load & probe ISA'}</button>{unicornReport ? <RuntimeBadge state="ready">v{unicornReport.version}</RuntimeBadge> : null}</div>
                  {unicornError ? <p className="runtime-engine-error">{unicornError}</p> : null}
                  {unicornReport ? <table className="runtime-capability-table"><thead><tr><th>Observed ISA</th><th>Result</th></tr></thead><tbody>{unicornReport.probes.map((probe) => <tr key={probe.id}><td>{probe.label}</td><td className={probe.supported ? 'supported' : 'unsupported'} title={probe.error ?? undefined}>{probe.supported ? 'supported' : 'unsupported'}</td></tr>)}</tbody></table> : null}
                </article>

                <article className="runtime-engine-card">
                  <header><Play size={15} /><strong>Blink process sandbox</strong><RuntimeBadge state="lazy">on demand</RuntimeBadge></header>
                  <p>Current dynamic-Linux userspace/process backend. It mounts the selected <code>PT_INTERP</code> + recursive <code>DT_NEEDED</code> closure, validates GNU symbol versions and preserves observed crash RIP/code-byte evidence.</p>
                  <div className="runtime-asset-list"><div><span>JS</span><code>vendor/blink/blinkenlib.js</code></div><div><span>WASM</span><code>vendor/blink/blinkenlib.wasm</code></div></div>
                </article>

                <article className="runtime-engine-card">
                  <header><FolderOpen size={15} /><strong>Guest runtime libraries</strong><RuntimeBadge state={globalDependencies.error ? 'error' : globalDependencies.entries.length ? 'ready' : 'warning'}>{globalDependencies.loading ? 'loading' : `${globalDependencies.entries.length} source${globalDependencies.entries.length === 1 ? '' : 's'}`}</RuntimeBadge></header>
                  <p>Global Dependencies are authoritative external runtime inputs. They are not copied into project exports and remain independent from NASM/GNU ld toolchain binaries.</p>
                  {globalDependencies.error ? <p className="runtime-engine-error">{globalDependencies.error}</p> : null}
                </article>
              </div>

              <h3>Kernel-less Linux contract</h3>
              <dl className="runtime-contract">
                <dt>Kernel</dt><dd>None. Guest Linux syscalls terminate at a browser userspace ABI/backend boundary.</dd>
                <dt>Unicorn today</dt><dd>Static ET_EXEC CPU execution with virtual stdin/stdout/stderr and Linux-lite syscall handling. Dynamic loader support is still migrating.</dd>
                <dt>Blink today</dt><dd>Dynamic x86-64 Linux process path with ld-linux/libc and Global Dependencies.</dd>
                <dt>Analysis</dt><dd>ELF bytes + Capstone remain canonical regardless of which execution backend is selected.</dd>
              </dl>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
