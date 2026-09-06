import { useEffect, useState } from 'react';

export interface AppSettings {
  theme: 'dark' | 'darker';
  fontSize: number;
  graphGrid: boolean;
  graphLabels: boolean;
  compactTabs: boolean;
}

const STORAGE_KEY = 'asm-graph-inspector.settings/v1';
const defaults: AppSettings = {
  theme: 'dark',
  fontSize: 13,
  graphGrid: true,
  graphLabels: true,
  compactTabs: false
};

function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) as Partial<AppSettings> };
  } catch {
    return defaults;
  }
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(readSettings);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);
  return { settings, setSettings };
}
