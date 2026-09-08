import { useEffect, useState } from 'react';

const CPU_SAMPLE_INTERVAL_MS = 1_000;
const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;

interface LegacyPerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface UserAgentMemoryEstimate {
  bytes: number;
}

type PerformanceWithMemory = Performance & {
  memory?: LegacyPerformanceMemory;
  measureUserAgentSpecificMemory?: () => Promise<UserAgentMemoryEstimate>;
};

export type RamMeasurementKind = 'page' | 'js-heap' | 'unavailable';

export interface BrowserResourceMetrics {
  cpuPercent: number | null;
  ramBytes: number | null;
  ramLimitBytes: number | null;
  ramKind: RamMeasurementKind;
  storageBytes: number | null;
  storageQuotaBytes: number | null;
  gpuAvailable: boolean;
}

interface MemorySample {
  bytes: number | null;
  limitBytes: number | null;
  kind: RamMeasurementKind;
}

interface StorageSample {
  bytes: number | null;
  quotaBytes: number | null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function readMemorySample(): Promise<MemorySample> {
  const perf = performance as PerformanceWithMemory;

  if (globalThis.crossOriginIsolated && typeof perf.measureUserAgentSpecificMemory === 'function') {
    try {
      const estimate = await perf.measureUserAgentSpecificMemory();
      const bytes = finiteNonNegative(estimate.bytes);
      if (bytes !== null) return { bytes, limitBytes: null, kind: 'page' };
    } catch {
      // Fall through to Chromium's legacy JS-heap signal when the stronger API is unavailable at runtime.
    }
  }

  const heap = perf.memory;
  if (heap) {
    const bytes = finiteNonNegative(heap.usedJSHeapSize);
    const limitBytes = finiteNonNegative(heap.jsHeapSizeLimit);
    if (bytes !== null) return { bytes, limitBytes, kind: 'js-heap' };
  }

  return { bytes: null, limitBytes: null, kind: 'unavailable' };
}

async function readStorageSample(): Promise<StorageSample> {
  if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
    return { bytes: null, quotaBytes: null };
  }

  try {
    const estimate = await navigator.storage.estimate();
    return {
      bytes: finiteNonNegative(estimate.usage),
      quotaBytes: finiteNonNegative(estimate.quota)
    };
  } catch {
    return { bytes: null, quotaBytes: null };
  }
}

export function useBrowserResourceMetrics(): BrowserResourceMetrics {
  const [metrics, setMetrics] = useState<BrowserResourceMetrics>(() => ({
    cpuPercent: null,
    ramBytes: null,
    ramLimitBytes: null,
    ramKind: 'unavailable',
    storageBytes: null,
    storageQuotaBytes: null,
    gpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator
  }));

  useEffect(() => {
    let disposed = false;
    let longTaskObserver: PerformanceObserver | null = null;
    let longTaskMilliseconds = 0;
    let cpuWindowStartedAt = performance.now();
    let resourceSampleInFlight = false;

    const longTaskSupported = typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes.includes('longtask');

    if (longTaskSupported) {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTaskMilliseconds += entry.duration;
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        longTaskObserver = null;
      }
    }

    const resetCpuWindow = () => {
      longTaskMilliseconds = 0;
      cpuWindowStartedAt = performance.now();
    };

    const sampleCpu = () => {
      const now = performance.now();
      const elapsed = Math.max(1, now - cpuWindowStartedAt);
      const cpuPercent = longTaskObserver && document.visibilityState === 'visible'
        ? Math.min(100, Math.max(0, (longTaskMilliseconds / elapsed) * 100))
        : null;

      longTaskMilliseconds = 0;
      cpuWindowStartedAt = now;
      if (!disposed) setMetrics((current) => ({ ...current, cpuPercent }));
    };

    const sampleResources = async () => {
      if (resourceSampleInFlight) return;
      resourceSampleInFlight = true;
      try {
        const [memory, storage] = await Promise.all([readMemorySample(), readStorageSample()]);
        if (disposed) return;
        setMetrics((current) => ({
          ...current,
          ramBytes: memory.bytes,
          ramLimitBytes: memory.limitBytes,
          ramKind: memory.kind,
          storageBytes: storage.bytes,
          storageQuotaBytes: storage.quotaBytes,
          gpuAvailable: 'gpu' in navigator
        }));
      } finally {
        resourceSampleInFlight = false;
      }
    };

    const cpuInterval = window.setInterval(sampleCpu, CPU_SAMPLE_INTERVAL_MS);
    const resourceInterval = window.setInterval(() => { void sampleResources(); }, RESOURCE_SAMPLE_INTERVAL_MS);
    document.addEventListener('visibilitychange', resetCpuWindow);
    void sampleResources();

    return () => {
      disposed = true;
      window.clearInterval(cpuInterval);
      window.clearInterval(resourceInterval);
      document.removeEventListener('visibilitychange', resetCpuWindow);
      longTaskObserver?.disconnect();
    };
  }, []);

  return metrics;
}
