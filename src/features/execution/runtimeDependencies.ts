import { inspectElfRuntimeLinkage } from '../binary/elfParser';
import { globalDependencyStore } from '../dependencies/globalDependencyStore';
import type { GlobalDependencyDirectory, GlobalDependencyFile } from '../dependencies/model';

export interface MaterializedRuntimeModule {
  requestedName: string;
  fileName: string;
  soname: string | null;
  bytes: ArrayBuffer;
  neededLibraries: string[];
  sourceId: string;
  sourceKind: 'file' | 'directory';
  sourceName: string;
}

export interface RuntimeDependencyClosure {
  interpreterPath: string | null;
  modules: MaterializedRuntimeModule[];
  totalBytes: number;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

async function directoryPermission(entry: GlobalDependencyDirectory): Promise<PermissionState> {
  if (!entry.handle.queryPermission) return 'granted';
  try { return await entry.handle.queryPermission({ mode: 'read' }); }
  catch { return 'prompt'; }
}

function fromImportedFile(requestedName: string, entry: GlobalDependencyFile): MaterializedRuntimeModule {
  const linkage = inspectElfRuntimeLinkage(entry.bytes);
  return {
    requestedName,
    fileName: entry.name,
    soname: linkage.soname ?? entry.soname,
    bytes: entry.bytes,
    neededLibraries: linkage.neededLibraries,
    sourceId: entry.id,
    sourceKind: 'file',
    sourceName: entry.name
  };
}

async function fromDirectory(requestedName: string, entry: GlobalDependencyDirectory): Promise<MaterializedRuntimeModule | null> {
  const permission = await directoryPermission(entry);
  if (permission !== 'granted') {
    throw new Error(`Global dependency directory ${entry.name} needs browser read permission before ${requestedName} can be executed.`);
  }
  try {
    const handle = await entry.handle.getFileHandle(requestedName);
    const file = await handle.getFile();
    const bytes = await file.arrayBuffer();
    const linkage = inspectElfRuntimeLinkage(bytes);
    return {
      requestedName,
      fileName: file.name,
      soname: linkage.soname,
      bytes,
      neededLibraries: linkage.neededLibraries,
      sourceId: entry.id,
      sourceKind: 'directory',
      sourceName: entry.name
    };
  } catch (error: unknown) {
    if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return null;
    throw error;
  }
}

async function materializeOne(requestedName: string): Promise<MaterializedRuntimeModule> {
  const entries = await globalDependencyStore.list();
  const files = entries.filter((entry): entry is GlobalDependencyFile => entry.kind === 'file');
  const directories = entries.filter((entry): entry is GlobalDependencyDirectory => entry.kind === 'directory');

  const imported = files.find((entry) => entry.soname === requestedName) ?? files.find((entry) => entry.name === requestedName);
  if (imported) return fromImportedFile(requestedName, imported);

  let permissionError: Error | null = null;
  for (const directory of directories) {
    try {
      const materialized = await fromDirectory(requestedName, directory);
      if (materialized) return materialized;
    } catch (error: unknown) {
      permissionError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (permissionError) throw permissionError;
  throw new Error(`Runtime dependency ${requestedName} is unresolved. Import the ELF or authorize a Global Dependencies directory containing it.`);
}

/**
 * Resolve the complete DT_NEEDED closure needed by a Linux process.
 * Resolution is exact-name/DT_SONAME based and never falls through to the host filesystem.
 */
export async function materializeRuntimeDependencyClosure(
  interpreterPath: string | null,
  directNeeded: string[],
  maxModules = 128,
  maxBytes = 256 * 1024 * 1024
): Promise<RuntimeDependencyClosure> {
  const pending: string[] = [];
  if (interpreterPath) pending.push(basename(interpreterPath));
  pending.push(...directNeeded);

  const byIdentity = new Map<string, MaterializedRuntimeModule>();
  const requestToIdentity = new Map<string, string>();
  let totalBytes = 0;

  while (pending.length) {
    const requestedName = pending.shift()!;
    if (!requestedName || requestToIdentity.has(requestedName)) continue;
    if (byIdentity.size >= maxModules) throw new Error(`Runtime dependency closure exceeds ${maxModules} ELF modules.`);

    const module = await materializeOne(requestedName);
    const identity = module.soname || module.fileName;
    requestToIdentity.set(requestedName, identity);
    if (byIdentity.has(identity)) continue;

    totalBytes += module.bytes.byteLength;
    if (totalBytes > maxBytes) throw new Error(`Runtime dependency bytes exceed the ${Math.floor(maxBytes / (1024 * 1024))} MiB sandbox preparation limit.`);
    byIdentity.set(identity, module);
    for (const dependency of module.neededLibraries) {
      if (!requestToIdentity.has(dependency)) pending.push(dependency);
    }
  }

  return { interpreterPath, modules: [...byIdentity.values()], totalBytes };
}
