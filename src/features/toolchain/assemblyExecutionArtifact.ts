import type { InspectorProject, ProjectFile } from '../project/model';
import type { AssemblerBackend } from './model';
import {
  buildAssemblyProject,
  type AssemblyProjectBuildOptions,
  type AssemblyProjectBuildResult
} from './projectAssemblyBuild';

export interface EnsuredAssemblyArtifact {
  file: ProjectFile;
  sourceFiles: ProjectFile[];
  reused: boolean;
  build: AssemblyProjectBuildResult | null;
}

function selectedAsmSources(project: InspectorProject, sourceFileIds?: string[]): ProjectFile[] {
  const requested = sourceFileIds ? new Set(sourceFileIds) : null;
  return project.files.filter((file) =>
    file.kind === 'text' &&
    file.language === 'asm' &&
    (!requested || requested.has(file.id))
  );
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function sourceRevisionMap(sources: ProjectFile[]): Map<string, { updatedAt: number; size: number }> {
  return new Map(sources.map((file) => [file.id, { updatedAt: file.updatedAt, size: file.size }]));
}

export function isFreshAssemblyArtifact(
  file: ProjectFile,
  project: InspectorProject,
  backendId: string,
  sourceFileIds?: string[]
): boolean {
  if (file.kind !== 'binary' || !file.bytes || file.bytes.byteLength === 0) return false;
  const generated = file.generated;
  if (!generated || generated.kind !== 'assembly-build') return false;
  if (generated.artifactKind !== 'elf-executable' || generated.backendId !== backendId) return false;

  const sources = selectedAsmSources(project, sourceFileIds ?? generated.sourceFileIds);
  if (!sources.length || !sameIds(generated.sourceFileIds, sources.map((file) => file.id))) return false;
  if (!generated.sourceRevisions?.length) return false;

  const expected = sourceRevisionMap(sources);
  if (generated.sourceRevisions.length !== expected.size) return false;
  return generated.sourceRevisions.every((revision) => {
    const current = expected.get(revision.fileId);
    return current !== undefined && current.updatedAt === revision.updatedAt && current.size === revision.size;
  });
}

export function findFreshAssemblyArtifact(
  project: InspectorProject,
  backendId: string,
  sourceFileIds?: string[],
  outputProjectPath?: string
): ProjectFile | null {
  const normalizedOutput = outputProjectPath?.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return project.files.find((file) =>
    (!normalizedOutput || file.path === normalizedOutput) &&
    isFreshAssemblyArtifact(file, project, backendId, sourceFileIds)
  ) ?? null;
}

export async function ensureAssemblyExecutable(
  project: InspectorProject,
  backend: AssemblerBackend,
  options: AssemblyProjectBuildOptions = {}
): Promise<EnsuredAssemblyArtifact> {
  const reusable = findFreshAssemblyArtifact(project, backend.id, options.sourceFileIds, options.outputProjectPath);
  if (reusable) {
    return {
      file: reusable,
      sourceFiles: selectedAsmSources(project, options.sourceFileIds),
      reused: true,
      build: null
    };
  }

  const build = await buildAssemblyProject(project, backend, options);
  if (!build.generatedFile) {
    const detail = build.assembly.diagnostics.map((item) => item.message).join(' ') || build.assembly.stderr.trim() || 'Unknown assembly failure.';
    throw new Error(detail);
  }
  if (build.generatedFile.generated?.artifactKind !== 'elf-executable') {
    throw new Error(`ASM execution requires an ELF executable artifact; backend produced ${build.generatedFile.generated?.artifactKind ?? 'unknown'}.`);
  }

  return {
    file: build.generatedFile,
    sourceFiles: build.sourceFiles,
    reused: false,
    build
  };
}
