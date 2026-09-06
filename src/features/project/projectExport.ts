import type { InspectorProject, ProjectFile } from './model';

export interface ProjectBundleFileV1 {
  id: string;
  path: string;
  name: string;
  kind: ProjectFile['kind'];
  language: ProjectFile['language'];
  size: number;
  updatedAt: number;
  content: { encoding: 'utf8' | 'base64'; data: string };
}

export interface ProjectBundleV1 {
  schema: 'asm-graph.project-bundle/v1';
  exportedAt: number;
  generator: 'ASM Graph Inspector';
  project: {
    schemaVersion: 1;
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    files: ProjectBundleFileV1[];
  };
  externals: { globalDependenciesEmbedded: false };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function exportFile(file: ProjectFile): ProjectBundleFileV1 {
  return {
    id: file.id,
    path: file.path,
    name: file.name,
    kind: file.kind,
    language: file.language,
    size: file.size,
    updatedAt: file.updatedAt,
    content: file.kind === 'binary'
      ? { encoding: 'base64', data: arrayBufferToBase64(file.bytes ?? new ArrayBuffer(0)) }
      : { encoding: 'utf8', data: file.text ?? '' }
  };
}

export function serializeProjectBundle(project: InspectorProject): string {
  const bundle: ProjectBundleV1 = {
    schema: 'asm-graph.project-bundle/v1',
    exportedAt: Date.now(),
    generator: 'ASM Graph Inspector',
    project: {
      schemaVersion: project.schemaVersion,
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      files: project.files.map(exportFile)
    },
    externals: { globalDependenciesEmbedded: false }
  };
  return JSON.stringify(bundle, null, 2);
}

function safeFileName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asm-graph-project';
}

export function downloadProjectBundle(project: InspectorProject): string {
  const fileName = `${safeFileName(project.name)}.asmgraph-project.json`;
  const blob = new Blob([serializeProjectBundle(project)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return fileName;
}
