import type { InspectorProject, ProjectSummary } from './model';

const DB_NAME = 'asm-graph-inspector';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export class ProjectStore {
  async list(): Promise<ProjectSummary[]> {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const records = await requestToPromise(tx.objectStore(STORE_NAME).getAll()) as InspectorProject[];
      return records
        .map((project) => ({
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          fileCount: project.files.length
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } finally {
      db.close();
    }
  }

  async get(id: string): Promise<InspectorProject | null> {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const value = await requestToPromise(tx.objectStore(STORE_NAME).get(id)) as InspectorProject | undefined;
      return value ?? null;
    } finally {
      db.close();
    }
  }

  async save(project: InspectorProject): Promise<void> {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(project);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Failed to save project'));
        tx.onabort = () => reject(tx.error ?? new Error('Project save aborted'));
      });
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Failed to delete project'));
      });
    } finally {
      db.close();
    }
  }
}

export const projectStore = new ProjectStore();
