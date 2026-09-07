import type { InspectorProject, ProjectFile } from '../project/model';
import type {
  AssemblerBackend,
  AssemblyRequest,
  AssemblyResult
} from './model';

export interface AssemblyProjectBuildOptions {
  sourceFileIds?: string[];
  entrySymbol?: string;
  outputProjectPath?: string;
  assemblerArgs?: string[];
  linkerArgs?: string[];
}

export interface AssemblyProjectBuildResult {
  assembly: AssemblyResult;
  sourceFiles: ProjectFile[];
  generatedFile: ProjectFile | null;
}

function cleanProjectPath(path: string): string {
  const clean = path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!clean || clean.split('/').some((part) => part === '..')) throw new Error(`Invalid generated project path: ${path}`);
  return clean;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'program';
}

function stem(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function safeName(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'program';
}

function failure(message: string): AssemblyResult {
  return {
    success: false,
    artifact: null,
    generatedArtifacts: [],
    diagnostics: [{ severity: 'error', message }],
    stdout: '',
    stderr: ''
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function defaultOutputProjectPath(sources: ProjectFile[]): string {
  if (sources.length === 1) return `build/${safeName(stem(sources[0].path))}`;
  return 'build/program';
}

export async function buildAssemblyProject(
  project: InspectorProject,
  backend: AssemblerBackend,
  options: AssemblyProjectBuildOptions = {}
): Promise<AssemblyProjectBuildResult> {
  const requestedIds = options.sourceFileIds ? new Set(options.sourceFileIds) : null;
  const sourceFiles = project.files.filter((file) =>
    file.kind === 'text' &&
    file.language === 'asm' &&
    (!requestedIds || requestedIds.has(file.id))
  );

  if (requestedIds) {
    const found = new Set(sourceFiles.map((file) => file.id));
    const missing = options.sourceFileIds!.filter((id) => !found.has(id));
    if (missing.length) {
      return {
        assembly: failure(`ASM build source selection contains missing or non-ASM file id(s): ${missing.join(', ')}.`),
        sourceFiles,
        generatedFile: null
      };
    }
  }

  if (!sourceFiles.length) {
    return {
      assembly: failure('ASM project build requires at least one text/asm source file.'),
      sourceFiles,
      generatedFile: null
    };
  }

  const outputProjectPath = cleanProjectPath(options.outputProjectPath ?? defaultOutputProjectPath(sourceFiles));
  const request: AssemblyRequest = {
    sources: sourceFiles.map((file) => ({ path: file.path, source: file.text ?? '' })),
    entrySymbol: options.entrySymbol ?? '_start',
    outputPath: '/work/build/program',
    assemblerArgs: options.assemblerArgs,
    linkerArgs: options.linkerArgs
  };
  const assembly = await backend.assemble(request);
  if (!assembly.success || !assembly.artifact) return { assembly, sourceFiles, generatedFile: null };

  const bytes = exactArrayBuffer(assembly.artifact.bytes);
  const builtAt = Date.now();
  const generatedFile: ProjectFile = {
    id: `generated:${project.id}:${outputProjectPath}`,
    path: outputProjectPath,
    name: baseName(outputProjectPath),
    kind: 'binary',
    language: 'binary',
    bytes,
    size: bytes.byteLength,
    updatedAt: builtAt,
    generated: {
      kind: 'assembly-build',
      backendId: backend.id,
      sourceFileIds: sourceFiles.map((file) => file.id),
      artifactKind: assembly.artifact.kind,
      builtAt
    }
  };

  return { assembly, sourceFiles, generatedFile };
}
