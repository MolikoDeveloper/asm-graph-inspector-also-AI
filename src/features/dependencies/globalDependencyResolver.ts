import { inspectElfRuntimeLinkage } from '../binary/elfParser';
import { makeId } from '../../shared/id';
import { globalDependencyStore } from './globalDependencyStore';
import type {
  FileSystemDirectoryHandleLike,
  GlobalDependencyDirectory,
  GlobalDependencyEntry,
  GlobalDependencyFile,
  GlobalDependencyResolution,
  GlobalDependencyResolutionRole
} from './model';

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function permissionForDirectory(entry: GlobalDependencyDirectory): Promise<PermissionState> {
  if (!entry.handle.queryPermission) return Promise.resolve('granted');
  return entry.handle.queryPermission({ mode: 'read' }).catch(() => 'prompt');
}

export async function makeGlobalDependencyFile(file: File): Promise<GlobalDependencyFile> {
  const bytes = await file.arrayBuffer();
  const linkage = inspectElfRuntimeLinkage(bytes);
  const now = Date.now();
  return {
    schema: 'asm-graph.global-dependency/v1',
    id: makeId('global-dependency'),
    kind: 'file',
    name: file.name,
    soname: linkage.soname,
    neededLibraries: linkage.neededLibraries,
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
  evidence: string,
  role: GlobalDependencyResolutionRole = 'direct',
  depth = 0,
  requestedBy: string | null = null,
  neededLibraries: string[] = []
): GlobalDependencyResolution {
  return {
    requestedName,
    status,
    sourceId: entry?.id ?? null,
    sourceKind: entry?.kind ?? null,
    sourceName: entry?.name ?? null,
    fileName,
    soname,
    evidence,
    role,
    depth,
    requestedBy,
    neededLibraries
  };
}

interface ResolvedCandidate {
  result: GlobalDependencyResolution;
  neededLibraries: string[];
}

async function resolveFromDirectory(
  requestedName: string,
  entry: GlobalDependencyDirectory,
  role: GlobalDependencyResolutionRole,
  depth: number,
  requestedBy: string | null
): Promise<ResolvedCandidate | null> {
  const permission = await permissionForDirectory(entry);
  if (permission !== 'granted') {
    return {
      result: resolution(requestedName, 'permission-required', entry, null, null, `Directory ${entry.name} requires browser read permission.`, role, depth, requestedBy),
      neededLibraries: []
    };
  }
  try {
    const handle = await entry.handle.getFileHandle(requestedName);
    const file = await handle.getFile();
    const bytes = await file.arrayBuffer();
    const linkage = inspectElfRuntimeLinkage(bytes);
    const neededLibraries = linkage.neededLibraries;
    return {
      result: resolution(
        requestedName,
        'resolved',
        entry,
        handle.name,
        linkage.soname,
        `Exact filename ${handle.name} found in authorized global directory ${entry.name}.`,
        role,
        depth,
        requestedBy,
        neededLibraries
      ),
      neededLibraries
    };
  } catch (error: unknown) {
    if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return null;
    return null;
  }
}

async function resolveOne(
  requestedName: string,
  entries: GlobalDependencyEntry[],
  role: GlobalDependencyResolutionRole,
  depth: number,
  requestedBy: string | null
): Promise<ResolvedCandidate> {
  const files = entries.filter((entry): entry is GlobalDependencyFile => entry.kind === 'file');
  const directories = entries.filter((entry): entry is GlobalDependencyDirectory => entry.kind === 'directory');
  const direct = files.find((entry) => entry.soname === requestedName) ?? files.find((entry) => entry.name === requestedName);
  if (direct) {
    let neededLibraries = direct.neededLibraries ?? [];
    let soname = direct.soname;
    // Older IndexedDB entries predate dependency metadata. Re-inspect their bytes lazily.
    if (!Array.isArray(direct.neededLibraries)) {
      const linkage = inspectElfRuntimeLinkage(direct.bytes);
      neededLibraries = linkage.neededLibraries;
      soname ??= linkage.soname;
    }
    return {
      result: resolution(
        requestedName,
        'resolved',
        direct,
        direct.name,
        soname,
        direct.soname === requestedName ? `Imported global ELF advertises DT_SONAME ${requestedName}.` : `Imported global dependency filename matches ${requestedName}.`,
        role,
        depth,
        requestedBy,
        neededLibraries
      ),
      neededLibraries
    };
  }

  let permissionRequired: ResolvedCandidate | null = null;
  for (const directory of directories) {
    const candidate = await resolveFromDirectory(requestedName, directory, role, depth, requestedBy);
    if (!candidate) continue;
    if (candidate.result.status === 'resolved') return candidate;
    permissionRequired ??= candidate;
  }
  if (permissionRequired) return permissionRequired;
  return {
    result: resolution(requestedName, 'unresolved', null, null, null, 'No imported global dependency or authorized global directory matched this ELF dependency.', role, depth, requestedBy),
    neededLibraries: []
  };
}

export async function resolveGlobalDependencies(requestedNames: string[]): Promise<GlobalDependencyResolution[]> {
  if (!requestedNames.length) return [];
  const entries = await globalDependencyStore.list();
  const results: GlobalDependencyResolution[] = [];
  for (const requestedName of requestedNames) {
    results.push((await resolveOne(requestedName, entries, 'direct', 0, null)).result);
  }
  return results;
}

/**
 * Resolve PT_INTERP + the recursive DT_NEEDED closure from the user's Global
 * Dependencies registry. This is a preflight view of the same closure the Blink
 * process sandbox materializes at execution time; it never searches the host OS.
 */
export async function resolveGlobalDependencyClosureFromEntries(
  entries: GlobalDependencyEntry[],
  interpreterPath: string | null,
  directNeeded: string[],
  maxModules = 128
): Promise<GlobalDependencyResolution[]> {
  const pending: Array<{ name: string; role: GlobalDependencyResolutionRole; depth: number; requestedBy: string | null }> = [];
  if (interpreterPath) pending.push({ name: basename(interpreterPath), role: 'interpreter', depth: 0, requestedBy: null });
  for (const name of directNeeded) pending.push({ name, role: 'direct', depth: 0, requestedBy: null });

  const results: GlobalDependencyResolution[] = [];
  const seen = new Set<string>();
  while (pending.length) {
    if (results.length >= maxModules) {
      results.push(resolution('[closure budget]', 'unresolved', null, null, null, `Runtime dependency closure exceeds ${maxModules} modules.`, 'transitive', 0, null));
      break;
    }
    const request = pending.shift()!;
    if (!request.name || seen.has(request.name)) continue;
    seen.add(request.name);
    const candidate = await resolveOne(request.name, entries, request.role, request.depth, request.requestedBy);
    results.push(candidate.result);
    if (candidate.result.status !== 'resolved') continue;
    const parentIdentity = candidate.result.soname ?? candidate.result.fileName ?? request.name;
    for (const child of candidate.neededLibraries) {
      if (seen.has(child)) continue;
      pending.push({ name: child, role: 'transitive', depth: request.depth + 1, requestedBy: parentIdentity });
    }
  }
  return results;
}
export async function resolveGlobalDependencyClosure(
  interpreterPath: string | null,
  directNeeded: string[],
  maxModules = 128
): Promise<GlobalDependencyResolution[]> {
  return resolveGlobalDependencyClosureFromEntries(await globalDependencyStore.list(), interpreterPath, directNeeded, maxModules);
}
