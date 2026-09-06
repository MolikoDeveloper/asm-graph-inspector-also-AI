import { useCallback, useEffect, useState } from 'react';
import { globalDependencyStore } from './globalDependencyStore';
import { makeGlobalDependencyDirectory, makeGlobalDependencyFile } from './globalDependencyResolver';
import type { FileSystemDirectoryHandleLike, GlobalDependencyEntry } from './model';

interface PickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: 'read' }) => Promise<FileSystemDirectoryHandleLike>;
}

export interface GlobalDependencyController {
  entries: GlobalDependencyEntry[];
  revision: number;
  loading: boolean;
  error: string | null;
  directoryPickerSupported: boolean;
  addFiles(files: FileList | File[]): Promise<void>;
  addDirectory(): Promise<void>;
  remove(id: string): Promise<void>;
  requestPermission(id: string): Promise<void>;
  refresh(): Promise<void>;
}

export function useGlobalDependencies(): GlobalDependencyController {
  const [entries, setEntries] = useState<GlobalDependencyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const directoryPickerSupported = typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await globalDependencyStore.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const changed = useCallback(async () => {
    setRevision((current) => current + 1);
    await refresh();
  }, [refresh]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    try {
      setError(null);
      for (const file of Array.from(files)) await globalDependencyStore.put(await makeGlobalDependencyFile(file));
      await changed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [changed]);

  const addDirectory = useCallback(async () => {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) {
      setError('This browser does not support persistent directory handles. Import library files instead.');
      return;
    }
    try {
      setError(null);
      const handle = await picker({ mode: 'read' });
      await globalDependencyStore.put(makeGlobalDependencyDirectory(handle));
      await changed();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [changed]);

  const remove = useCallback(async (id: string) => {
    await globalDependencyStore.delete(id);
    await changed();
  }, [changed]);

  const requestPermission = useCallback(async (id: string) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry || entry.kind !== 'directory' || !entry.handle.requestPermission) return;
    try {
      const permission = await entry.handle.requestPermission({ mode: 'read' });
      if (permission !== 'granted') setError(`Read permission was not granted for ${entry.name}.`);
      else setError(null);
      setRevision((current) => current + 1);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [entries, refresh]);

  return { entries, revision, loading, error, directoryPickerSupported, addFiles, addDirectory, remove, requestPermission, refresh };
}
