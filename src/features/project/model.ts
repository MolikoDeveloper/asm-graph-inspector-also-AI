export type ProjectFileKind = 'text' | 'binary';

export interface GeneratedProjectFileSourceRevision {
  fileId: string;
  updatedAt: number;
  size: number;
  sha256: string;
}

export interface GeneratedProjectFileInfo {
  kind: 'assembly-build';
  backendId: string;
  sourceFileIds: string[];
  sourceRevisions?: GeneratedProjectFileSourceRevision[];
  artifactKind: 'elf-executable' | 'elf-object' | 'flat-binary';
  builtAt: number;
}

export interface ProjectFile {
  id: string;
  path: string;
  name: string;
  kind: ProjectFileKind;
  language: 'asm' | 'disassembly-dump' | 'text' | 'json' | 'markdown' | 'binary';
  text?: string;
  bytes?: ArrayBuffer;
  size: number;
  updatedAt: number;
  generated?: GeneratedProjectFileInfo;
}

export interface InspectorProject {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  files: ProjectFile[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  fileCount: number;
}
