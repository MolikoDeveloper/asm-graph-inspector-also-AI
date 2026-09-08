import { Activity, CheckCircle2, Cpu, FileCode2, HardDrive, MemoryStick, Monitor, Save } from 'lucide-react';
import type { InspectorProject, ProjectFile } from '../features/project/model';
import type { CapstoneStatus } from '../features/capstone/capstoneLoader';
import { useBrowserResourceMetrics } from '../features/telemetry/useBrowserResourceMetrics';
import './StatusBar.css';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'N/A';
  if (bytes === 0) return '0 B';
  const unitIndex = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** unitIndex);
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unitIndex]}`;
}

function formatPercent(value: number | null): string {
  return value === null ? 'N/A' : `${Math.round(value)}%`;
}

function usageTitle(label: string, used: number | null, limit: number | null): string {
  if (used === null) return `${label} usage is unavailable in this browser.`;
  if (limit === null || limit <= 0) return `${label}: ${formatBytes(used)}.`;
  const percent = Math.min(100, Math.max(0, (used / limit) * 100));
  return `${label}: ${formatBytes(used)} of ${formatBytes(limit)} (${percent.toFixed(percent < 1 ? 2 : 1)}%).`;
}

export function StatusBar({ project, activeFile, saveState, capstoneStatus, nodeCount }: { project: InspectorProject; activeFile: ProjectFile | null; saveState: 'saved' | 'dirty' | 'saving' | 'error'; capstoneStatus: CapstoneStatus; nodeCount: number }) {
  const metrics = useBrowserResourceMetrics();
  const cpuAvailable = metrics.cpuPercent !== null;
  const ramAvailable = metrics.ramBytes !== null;
  const storageAvailable = metrics.storageBytes !== null;
  const cpuTitle = cpuAvailable
    ? 'CPU~ is estimated page main-thread pressure from Long Tasks. Browsers do not expose process or system-wide CPU utilization.'
    : 'CPU utilization is not exposed by this browser. The status bar does not invent a percentage.';
  const ramTitle = metrics.ramKind === 'page'
    ? usageTitle('Page memory', metrics.ramBytes, metrics.ramLimitBytes)
    : metrics.ramKind === 'js-heap'
      ? `${usageTitle('JavaScript heap', metrics.ramBytes, metrics.ramLimitBytes)} Chromium fallback; workers/WASM memory may not be fully represented.`
      : 'RAM usage is unavailable in this browser.';
  const gpuTitle = metrics.gpuAvailable
    ? 'WebGPU is available, but browsers do not expose a reliable GPU utilization percentage to web pages.'
    : 'GPU utilization is not available to this page; WebGPU is also unavailable.';
  const storageTitle = usageTitle('Origin storage', metrics.storageBytes, metrics.storageQuotaBytes);

  return (
    <footer className="status-bar">
      <div className="status-left">
        <span><CheckCircle2 size={13} /> {project.name}</span>
        <span><Save size={13} /> {saveState}</span>
      </div>
      <div className="status-right">
        <span className="status-runtime-detail"><Cpu size={13} /> Capstone: {capstoneStatus}</span>
        <span className="status-runtime-detail"><FileCode2 size={13} /> {activeFile?.name ?? 'No file'}</span>
        <span className="status-secondary-detail">Nodes: {nodeCount}</span>
        <span className="status-secondary-detail">Ready</span>
        <div className="status-metrics" aria-label="Browser resource metrics">
          <span className={`status-metric ${cpuAvailable ? '' : 'unavailable'}`} title={cpuTitle}>
            <Activity size={12} />
            <small>CPU~</small>
            <strong>{formatPercent(metrics.cpuPercent)}</strong>
          </span>
          <span className={`status-metric ${ramAvailable ? '' : 'unavailable'}`} title={ramTitle}>
            <MemoryStick size={12} />
            <small>RAM</small>
            <strong>{formatBytes(metrics.ramBytes)}</strong>
          </span>
          <span className="status-metric unavailable" title={gpuTitle}>
            <Monitor size={12} />
            <small>GPU</small>
            <strong>N/A</strong>
          </span>
          <span className={`status-metric ${storageAvailable ? '' : 'unavailable'}`} title={storageTitle}>
            <HardDrive size={12} />
            <small>Storage</small>
            <strong>{formatBytes(metrics.storageBytes)}</strong>
          </span>
        </div>
      </div>
    </footer>
  );
}
