import type { AssemblerBackend, AssemblyRequest, AssemblyResult } from '../../src/features/toolchain/model';
import { ensureAssemblyExecutable, isFreshAssemblyArtifact } from '../../src/features/toolchain/assemblyExecutionArtifact';
import type { InspectorProject } from '../../src/features/project/model';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class CountingBackend implements AssemblerBackend {
  readonly id = 'fake-nasm';
  readonly name = 'Fake NASM';
  calls = 0;

  async assemble(_request: AssemblyRequest): Promise<AssemblyResult> {
    this.calls += 1;
    return {
      success: true,
      artifact: {
        path: '/work/build/program',
        kind: 'elf-executable',
        bytes: Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, this.calls]),
        generatedBy: 'fixture'
      },
      generatedArtifacts: [],
      diagnostics: [],
      stdout: '',
      stderr: ''
    };
  }
}

function makeProject(updatedAt = 10): InspectorProject {
  const source = 'global _start\n_start:\n  ret\n';
  return {
    schemaVersion: 1,
    id: 'project-exec',
    name: 'exec fixture',
    createdAt: 1,
    updatedAt,
    files: [{
      id: 'main',
      path: 'src/main.asm',
      name: 'main.asm',
      kind: 'text',
      language: 'asm',
      text: source,
      size: new TextEncoder().encode(source).byteLength,
      updatedAt
    }]
  };
}

const backend = new CountingBackend();
const initialProject = makeProject();
const first = await ensureAssemblyExecutable(initialProject, backend, { sourceFileIds: ['main'] });
assert(!first.reused, 'first execution artifact must build');
assert(backend.calls === 1, 'first execution artifact should invoke assembler once');
assert(first.file.generated?.sourceRevisions?.[0]?.updatedAt === 10, 'generated artifact must retain source revision');
assert(first.file.generated?.sourceRevisions?.[0]?.sha256.length === 64, 'generated artifact must retain SHA-256 source identity');

const projectWithArtifact: InspectorProject = {
  ...initialProject,
  files: [...initialProject.files, first.file]
};
assert(await isFreshAssemblyArtifact(first.file, projectWithArtifact, backend.id, ['main']), 'fresh generated artifact should match current source revision');

const second = await ensureAssemblyExecutable(projectWithArtifact, backend, { sourceFileIds: ['main'] });
assert(second.reused, 'unchanged ASM should reuse its generated ELF');
assert(second.file.id === first.file.id, 'reused execution artifact should preserve stable project file identity');
assert(backend.calls === 1, 'unchanged ASM must not invoke assembler again');

const changedSource = {
  ...initialProject.files[0],
  text: `${initialProject.files[0].text}nop\n`,
  size: initialProject.files[0].size + 4,
  updatedAt: 11
};
const changedProject: InspectorProject = {
  ...projectWithArtifact,
  updatedAt: 11,
  files: [changedSource, first.file]
};
assert(!(await isFreshAssemblyArtifact(first.file, changedProject, backend.id, ['main'])), 'source edit must stale the previous generated ELF');

const sameMetadataDifferentText = {
  ...initialProject.files[0],
  text: 'global _start\n_start:\n  nop\n',
  size: initialProject.files[0].size,
  updatedAt: initialProject.files[0].updatedAt
};
const collisionGuardProject: InspectorProject = {
  ...projectWithArtifact,
  files: [sameMetadataDifferentText, first.file]
};
assert(!(await isFreshAssemblyArtifact(first.file, collisionGuardProject, backend.id, ['main'])), 'SHA-256 must stale an artifact even if timestamp and byte count metadata collide');

const rebuilt = await ensureAssemblyExecutable(changedProject, backend, { sourceFileIds: ['main'] });
assert(!rebuilt.reused, 'edited ASM must rebuild before execution');
assert(backend.calls === 2, 'edited ASM should invoke assembler exactly once more');
assert(rebuilt.file.id === first.file.id, 'rebuild must replace the same generated project artifact identity');
assert(rebuilt.file.generated?.sourceRevisions?.[0]?.updatedAt === 11, 'rebuilt artifact must stamp the new source revision');

console.log('ASM execution artifact smoke: PASS (SHA-256 freshness -> reuse unchanged ELF -> rebuild edited source)');
