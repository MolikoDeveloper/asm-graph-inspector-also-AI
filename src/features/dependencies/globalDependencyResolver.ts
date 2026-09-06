import { inspectElfRuntimeLinkage } from '../binary/elfParser';
import { makeId } from '../../shared/id';
import { globalDependencyStore } from './globalDependencyStore';
import type {
  FileSystemDirectoryHandleLike,
  GlobalDependencyDirectory,
  GlobalDependencyEntry,
  GlobalDependencyFile,
  GlobalDependencyResolution
} from './model';

function permissionForDirectory(entry: GlobalDependencyDirectory): Promise<PermissionState> {
  if (!entry.handle.queryPermission) return Promise.resolve('granted');
  return entry.handle.queryPermission({ mode: 'read' }).catch(() => 'prompt');
}

export async function makeGlobalDependencyFile(file: File): Promise<GlobalDependencyFile> {
  const bytes = await file.arrayBuffer();
  const soname = inspectElfRuntimeLinkage(bytes).soname;
  const now = Date.now();
  return {
    schema: 'asm-graph.global-dependency/v1',
    id: makeId('global-dependency'),
    kind: 'file',
    name: file.name,
    soname,
    size: file.size,
    bytes,
    addedAt: now,
    updatedAt: now
  };
}

export function makeGlobalDependencyDirectory(handle: FileSystemDirectoryHandleLike): GlobalDependencyDirectory {
  const now = Date.now();
  return {
    schema: 'asm-graph.global-dependency/v1',
    id: makeId('global-dependency'),
    kind: 'directory',
    name: handle.name,
    handle,
    addedAt: now,
    updatedAt: now
  };
}

function resolution(
  requestedName: string,
  status: GlobalDependencyResolution['status'],
  entry: GlobalDependencyEntry | null,
  fileName: string | null,
  soname: string | null,
  evidence: string
): GlobalDependencyResolution {
  return {
    requestedName,
    status,
    sourceId: entry?.id ?? null,
    sourceKind: entry?.kind ?? null,
    sourceName: entry?.name ?? null,
    fileName,
    soname,
    evidence
  };
}

async function resolveFromDirectory(requestedName: string, entry: GlobalDependencyDirectory): Promise<GlobalDependencyResolution | null> {
  const permission = await permissionForDirectory(entry);
  if (permission !== 'granted') {
    return resolution(requestedName, 'permission-required', entry, null, null, `Directory ${entry.name} requires browser read permission.`);
  }
  try {
    const handle = await entry.handle.getFileHandle(requestedName);
    return resolution(requestedName, 'resolved', entry, handle.name, null, `Exact filename ${handle.name} found in authorized global directory ${entry.name}.`);
  } catch {
    return null;
  }
}

export async function resolveGlobalDependencies(requestedNames: string[]): Promise<GlobalDependencyResolution[]> {
  if (!requestedNames.length) return [];
  const entries = await globalDependencyStore.list();
  const files = entries.filter((entry): entry is GlobalDependencyFile => entry.kind === 'file');
  const directories = entries.filter((entry): entry is GlobalDependencyDirectory => entry.kind === 'directory');
  const results: GlobalDependencyResolution[] = [];

  for (const requestedName of requestedNames) {
    const direct = files.find((entry) => entry.soname === requestedName) ?? files.find((entry) => entry.name === requestedName);
    if (direct) {
      results.push(resolution(requestedName, 'resolved', direct, direct.name, direct.soname, direct.soname === requestedName ? `Imported global ELF advertises DT_SONAME ${requestedName}.` : `Imported global dependency filename matches ${requestedName}.`));
      continue;
    }

    let permissionRequired: GlobalDependencyResolution | null = null;
    let resolved: GlobalDependencyResolution | null = null;
    for (const directory of directories) {
      const candidate = await resolveFromDirectory(requestedName, directory);
      if (!candidate) continue;
      if (candidate.status === 'resolved') {
        resolved = candidate;
        break;
      }
      permissionRequired ??= candidate;
    }
    results.push(resolved ?? permissionRequired ?? resolution(requestedName, 'unresolved', null, null, null, 'No imported global dependency or authorized global directory matched this DT_NEEDED entry.'));
  }

  return results;
}
