import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeId } from '../../shared/id';
import { projectStore } from './projectStore';
import type { InspectorProject, ProjectFile, ProjectSummary } from './model';

const SAMPLE_ASM = `section .data
    msg: db "Hello, world!", 0xa
    msg_len: equ $ - msg

section .text
    global _start

_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, msg
    mov rdx, msg_len
    syscall

    mov rax, 60
    mov rdi, 0
    syscall
`;

export interface ProjectController {
  project: InspectorProject | null;
  summaries: ProjectSummary[];
  loading: boolean;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  createProject(name: string, withSample?: boolean): Promise<void>;
  openProject(id: string): Promise<void>;
  closeProject(): void;
  deleteProject(id: string): Promise<void>;
  addFiles(files: ProjectFile[]): void;
  createTextFile(path: string, content?: string): ProjectFile | null;
  updateFileText(fileId: string, text: string): void;
  removeFile(fileId: string): void;
  renameFile(fileId: string, path: string): void;
  moveFile(fileId: string, destinationDirectory: string): void;
  duplicateFile(fileId: string, path: string): ProjectFile | null;
  renameFolder(folderPath: string, nextFolderPath: string): void;
  removeFolder(folderPath: string): string[];
  saveNow(): Promise<void>;
  refreshProjects(): Promise<void>;
}

export function useProjectController(): ProjectController {
  const [project, setProject] = useState<InspectorProject | null>(null);
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<ProjectController['saveState']>('saved');
  const saveTimer = useRef<number | null>(null);
  const projectRef = useRef<InspectorProject | null>(null);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const refreshProjects = useCallback(async () => {
    try {
      setSummaries(await projectStore.list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!project || saveState !== 'dirty') return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const snapshot = projectRef.current;
      if (!snapshot) return;
      setSaveState('saving');
      try {
        await projectStore.save(snapshot);
        setSaveState('saved');
        void refreshProjects();
      } catch {
        setSaveState('error');
      }
    }, 650);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [project, saveState, refreshProjects]);

  const createProject = useCallback(async (name: string, withSample = true) => {
    const now = Date.now();
    const files: ProjectFile[] = withSample ? [{
      id: makeId('file'),
      path: 'src/main.asm',
      name: 'main.asm',
      kind: 'text',
      language: 'asm',
      text: SAMPLE_ASM,
      size: new TextEncoder().encode(SAMPLE_ASM).byteLength,
      updatedAt: now
    }] : [];
    const next: InspectorProject = {
      schemaVersion: 1,
      id: makeId('project'),
      name: name.trim() || 'Untitled project',
      createdAt: now,
      updatedAt: now,
      files
    };
    await projectStore.save(next);
    setProject(next);
    setSaveState('saved');
    await refreshProjects();
  }, [refreshProjects]);

  const openProject = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const found = await projectStore.get(id);
      if (found) {
        setProject(found);
        setSaveState('saved');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const closeProject = useCallback(() => {
    setProject(null);
    setSaveState('saved');
  }, []);

  const deleteProject = useCallback(async (id: string) => {
    await projectStore.delete(id);
    if (projectRef.current?.id === id) setProject(null);
    await refreshProjects();
  }, [refreshProjects]);

  const mutate = useCallback((fn: (draft: InspectorProject) => InspectorProject) => {
    setProject((current) => {
      if (!current) return current;
      const next = fn(current);
      return { ...next, updatedAt: Date.now() };
    });
    setSaveState('dirty');
  }, []);

  const addFiles = useCallback((files: ProjectFile[]) => {
    mutate((current) => {
      const existingByPath = new Map(current.files.map((file) => [file.path, file]));
      for (const file of files) {
        const existing = existingByPath.get(file.path);
        existingByPath.set(file.path, existing ? { ...file, id: existing.id } : file);
      }
      return { ...current, files: [...existingByPath.values()] };
    });
  }, [mutate]);

  const createTextFile = useCallback((path: string, content = ''): ProjectFile | null => {
    const currentProject = projectRef.current;
    if (!currentProject) return null;
    const clean = path.trim().replace(/^\/+/, '');
    if (!clean) return null;
    const existing = currentProject.files.find((file) => file.path === clean);
    if (existing) return existing;
    const file: ProjectFile = {
      id: makeId('file'),
      path: clean,
      name: clean.split('/').pop() || clean,
      kind: 'text',
      language: clean.endsWith('.asm') || clean.endsWith('.s') ? 'asm' : 'text',
      text: content,
      size: new TextEncoder().encode(content).byteLength,
      updatedAt: Date.now()
    };
    addFiles([file]);
    return file;
  }, [addFiles]);

  const updateFileText = useCallback((fileId: string, text: string) => {
    mutate((current) => ({
      ...current,
      files: current.files.map((file) => file.id === fileId ? {
        ...file,
        text,
        size: new TextEncoder().encode(text).byteLength,
        updatedAt: Date.now()
      } : file)
    }));
  }, [mutate]);

  const removeFile = useCallback((fileId: string) => {
    mutate((current) => ({ ...current, files: current.files.filter((file) => file.id !== fileId) }));
  }, [mutate]);

  const renameFile = useCallback((fileId: string, path: string) => {
    const clean = path.trim().replace(/^\/+/, '');
    if (!clean) return;
    mutate((current) => ({
      ...current,
      files: current.files.map((file) => file.id === fileId ? {
        ...file,
        path: clean,
        name: clean.split('/').pop() || clean,
        language: file.kind === 'text' ? (clean.endsWith('.asm') || clean.endsWith('.s') ? 'asm' : 'text') : file.language,
        updatedAt: Date.now()
      } : file)
    }));
  }, [mutate]);


  const moveFile = useCallback((fileId: string, destinationDirectory: string) => {
    const currentProject = projectRef.current;
    const file = currentProject?.files.find((candidate) => candidate.id === fileId);
    if (!file) return;
    const directory = destinationDirectory.trim().replace(/^\/+|\/+$/g, '');
    const path = directory ? `${directory}/${file.name}` : file.name;
    if (currentProject?.files.some((candidate) => candidate.id !== fileId && candidate.path === path)) return;
    renameFile(fileId, path);
  }, [renameFile]);

  const duplicateFile = useCallback((fileId: string, path: string): ProjectFile | null => {
    const currentProject = projectRef.current;
    const source = currentProject?.files.find((candidate) => candidate.id === fileId);
    const clean = path.trim().replace(/^\/+/, '');
    if (!source || !clean || currentProject?.files.some((candidate) => candidate.path === clean)) return null;
    const copy: ProjectFile = {
      ...source,
      id: makeId('file'),
      path: clean,
      name: clean.split('/').pop() || clean,
      bytes: source.bytes ? source.bytes.slice(0) : undefined,
      updatedAt: Date.now()
    };
    addFiles([copy]);
    return copy;
  }, [addFiles]);

  const renameFolder = useCallback((folderPath: string, nextFolderPath: string) => {
    const from = folderPath.trim().replace(/^\/+|\/+$/g, '');
    const to = nextFolderPath.trim().replace(/^\/+|\/+$/g, '');
    if (!from || !to || from === to) return;
    mutate((current) => {
      const affected = current.files.filter((file) => file.path === from || file.path.startsWith(`${from}/`));
      if (!affected.length) return current;
      const affectedIds = new Set(affected.map((file) => file.id));
      const occupied = new Set(current.files.filter((file) => !affectedIds.has(file.id)).map((file) => file.path));
      const replacements = new Map<string, string>();
      for (const file of affected) {
        const suffix = file.path.slice(from.length).replace(/^\//, '');
        const path = suffix ? `${to}/${suffix}` : to;
        if (occupied.has(path) || [...replacements.values()].includes(path)) return current;
        replacements.set(file.id, path);
      }
      return {
        ...current,
        files: current.files.map((file) => {
          const path = replacements.get(file.id);
          return path ? { ...file, path, name: path.split('/').pop() || path, updatedAt: Date.now() } : file;
        })
      };
    });
  }, [mutate]);

  const removeFolder = useCallback((folderPath: string): string[] => {
    const clean = folderPath.trim().replace(/^\/+|\/+$/g, '');
    if (!clean) return [];
    const ids = projectRef.current?.files.filter((file) => file.path.startsWith(`${clean}/`)).map((file) => file.id) ?? [];
    if (!ids.length) return [];
    const removed = new Set(ids);
    mutate((current) => ({ ...current, files: current.files.filter((file) => !removed.has(file.id)) }));
    return ids;
  }, [mutate]);

  const saveNow = useCallback(async () => {
    const snapshot = projectRef.current;
    if (!snapshot) return;
    setSaveState('saving');
    try {
      await projectStore.save(snapshot);
      setSaveState('saved');
      await refreshProjects();
    } catch {
      setSaveState('error');
    }
  }, [refreshProjects]);

  return useMemo(() => ({
    project,
    summaries,
    loading,
    saveState,
    createProject,
    openProject,
    closeProject,
    deleteProject,
    addFiles,
    createTextFile,
    updateFileText,
    removeFile,
    renameFile,
    moveFile,
    duplicateFile,
    renameFolder,
    removeFolder,
    saveNow,
    refreshProjects
  }), [project, summaries, loading, saveState, createProject, openProject, closeProject, deleteProject, addFiles, createTextFile, updateFileText, removeFile, renameFile, moveFile, duplicateFile, renameFolder, removeFolder, saveNow, refreshProjects]);
}
