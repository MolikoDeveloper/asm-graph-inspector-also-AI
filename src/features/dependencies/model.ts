export type GlobalDependencyKind = 'file' | 'directory';

export interface FileSystemPermissionDescriptorLike {
  mode?: 'read';
}

export interface FileSystemFileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  queryPermission?(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
}

export interface FileSystemDirectoryHandleLike {
  kind: 'directory';
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike>;
  queryPermission?(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemPermissionDescriptorLike): Promise<PermissionState>;
}

export interface GlobalDependencyFile {
  schema: 'asm-graph.global-dependency/v1';
  id: string;
  kind: 'file';
  name: string;
  soname: string | null;
  neededLibraries: string[];
  size: number;
  bytes: ArrayBuffer;
  addedAt: number;
  updatedAt: number;
}

export interface GlobalDependencyDirectory {
  schema: 'asm-graph.global-dependency/v1';
  id: string;
  kind: 'directory';
  name: string;
  handle: FileSystemDirectoryHandleLike;
  addedAt: number;
  updatedAt: number;
}

export type GlobalDependencyEntry = GlobalDependencyFile | GlobalDependencyDirectory;

export type GlobalDependencyResolutionStatus = 'resolved' | 'unresolved' | 'permission-required';

export type GlobalDependencyResolutionRole = 'interpreter' | 'direct' | 'transitive';

export interface GlobalDependencyResolution {
  requestedName: string;
  status: GlobalDependencyResolutionStatus;
  sourceId: string | null;
  sourceKind: GlobalDependencyKind | null;
  sourceName: string | null;
  fileName: string | null;
  soname: string | null;
  evidence: string;
  role: GlobalDependencyResolutionRole;
  depth: number;
  requestedBy: string | null;
  neededLibraries: string[];
}
