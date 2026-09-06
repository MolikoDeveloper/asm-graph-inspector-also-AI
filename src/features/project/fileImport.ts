import { makeId } from '../../shared/id';
import type { ProjectFile } from './model';

const TEXT_EXTENSIONS = new Set([
  'asm', 's', 'fasm', 'nasm', 'inc', 'txt', 'md', 'json', 'toml', 'yaml', 'yml', 'c', 'h', 'cpp', 'hpp', 'zig', 'ts', 'tsx', 'js', 'jsx'
]);

function languageForName(name: string): ProjectFile['language'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['asm', 's', 'fasm', 'nasm', 'inc'].includes(ext)) return 'asm';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

export async function importBrowserFile(file: File, pathOverride?: string): Promise<ProjectFile> {
  const language = languageForName(file.name);
  const path = pathOverride || file.webkitRelativePath || file.name;
  if (language !== 'binary') {
    return {
      id: makeId('file'),
      path,
      name: file.name,
      kind: 'text',
      language,
      text: await file.text(),
      size: file.size,
      updatedAt: Date.now()
    };
  }

  return {
    id: makeId('file'),
    path,
    name: file.name,
    kind: 'binary',
    language: 'binary',
    bytes: await file.arrayBuffer(),
    size: file.size,
    updatedAt: Date.now()
  };
}
