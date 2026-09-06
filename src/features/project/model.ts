export type ProjectFileKind = 'text' | 'binary';

export interface ProjectFile {
  id: string;
  path: string;
  name: string;
  kind: ProjectFileKind;
  language: 'asm' | 'text' | 'json' | 'markdown' | 'binary';
  text?: string;
  bytes?: ArrayBuffer;
  size: number;
  updatedAt: number;
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
