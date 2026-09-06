import type { GlobalDependencyEntry } from './model';

const DB_NAME = 'asm-graph-inspector-global-dependencies';
const DB_VERSION = 1;
const STORE_NAME = 'dependencies';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open global dependency database.'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Global dependency IndexedDB request failed.'));
  });
}

async function complete(tx: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Global dependency transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Global dependency transaction aborted.'));
  });
}

export class GlobalDependencyStore {
  async list(): Promise<GlobalDependencyEntry[]> {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const entries = await requestToPromise(tx.objectStore(STORE_NAME).getAll()) as GlobalDependencyEntry[];
      return entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    } finally {
      db.close();
    }
  }

  async put(entry: GlobalDependencyEntry): Promise<void> {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(entry);
      await complete(tx);
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    const db = await openDatabase();
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      await complete(tx);
    } finally {
      db.close();
    }
  }
}

export const globalDependencyStore = new GlobalDependencyStore();
