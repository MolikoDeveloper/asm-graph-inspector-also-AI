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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sourceSha256(file: ProjectFile): Promise<string> {
  const bytes = new TextEncoder().encode(file.text ?? '');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function isFreshAssemblyArtifact(
  file: ProjectFile,
  project: InspectorProject,
  backendId: string,
  sourceFileIds?: string[]
): Promise<boolean> {
  if (file.kind !== 'binary' || !file.bytes || file.bytes.byteLength === 0) return false;
  const generated = file.generated;
  if (!generated || generated.kind !== 'assembly-build') return false;
  if (generated.artifactKind !== 'elf-executable' || generated.backendId !== backendId) return false;

  const sources = selectedAsmSources(project, sourceFileIds ?? generated.sourceFileIds);
  if (!sources.length || !sameIds(generated.sourceFileIds, sources.map((source) => source.id))) return false;
  if (!generated.sourceRevisions?.length || generated.sourceRevisions.length !== sources.length) return false;

  const revisions = new Map(generated.sourceRevisions.map((revision) => [revision.fileId, revision]));
  for (const source of sources) {
    const revision = revisions.get(source.id);
    if (!revision) return false;
    if (revision.updatedAt !== source.updatedAt || revision.size !== source.size) return false;
    if (revision.sha256 !== await sourceSha256(source)) return false;
  }
  return true;
}

export async function findFreshAssemblyArtifact(
  project: InspectorProject,
  backendId: string,
  sourceFileIds?: string[],
  outputProjectPath?: string
): Promise<ProjectFile | null> {
  const normalizedOutput = outputProjectPath?.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  for (const file of project.files) {
    if (normalizedOutput && file.path !== normalizedOutput) continue;
    if (await isFreshAssemblyArtifact(file, project, backendId, sourceFileIds)) return file;
  }
  return null;
}

export async function ensureAssemblyExecutable(
  project: InspectorProject,
  backend: AssemblerBackend,
  options: AssemblyProjectBuildOptions = {}
): Promise<EnsuredAssemblyArtifact> {
  const reusable = await findFreshAssemblyArtifact(project, backend.id, options.sourceFileIds, options.outputProjectPath);
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
