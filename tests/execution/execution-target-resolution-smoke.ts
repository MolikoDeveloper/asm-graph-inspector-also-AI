import type { BinaryAnalysisSummary, LoadedImage } from '../../src/features/binary/model';
import type { ProjectFile } from '../../src/features/project/model';
import {
  canResolveExecutionTargetFromFile,
  resolveBinaryExecutionTarget,
  shouldRestartRunFromStatus
} from '../../src/features/execution/targetResolution';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]).buffer;
const file: ProjectFile = {
  id: 'one-click-elf',
  path: 'build/ray_test',
  name: 'ray_test',
  kind: 'binary',
  language: 'binary',
  bytes,
  size: bytes.byteLength,
  updatedAt: 1
};
const image = {
  schema: 'asm-graph.loaded-image/v1',
  sourceFileId: file.id,
  sourcePath: file.path,
  architecture: 'x86-64',
  byteOrder: 'little',
  kind: 'executable',
  entry: 0x401000,
  buildId: null,
  soname: null,
  neededLibraries: [],
  interpreter: null,
  segments: [],
  sections: [],
  symbols: [],
  relocations: [],
  functions: [],
  unwind: { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 }
} as LoadedImage;

assert(canResolveExecutionTargetFromFile(file), 'binary ELF bytes should enable Run before background analysis completes');
assert(!canResolveExecutionTargetFromFile(null), 'no active file must not enable execution');
assert(!shouldRestartRunFromStatus('ready'), 'ready session should run without recreation');
assert(!shouldRestartRunFromStatus('paused'), 'Run from pause should continue the same process');
assert(shouldRestartRunFromStatus('exited'), 'Run after exit must recreate the process automatically');
assert(shouldRestartRunFromStatus('halted'), 'Run after halt must recreate the process automatically');
assert(shouldRestartRunFromStatus('trapped'), 'Run after trap must recreate the process automatically');

let analyses = 0;
const analyzed = await resolveBinaryExecutionTarget(file, null, async (candidate) => {
  analyses += 1;
  assert(candidate.id === file.id, 'on-demand analysis must receive the active binary');
  return { kind: 'binary', file: candidate, image };
});
assert(analyses === 1, 'missing summary must trigger exactly one authoritative on-demand analysis');
assert(analyzed.kind === 'binary' && analyzed.image === image, 'on-demand analysis target must flow directly into execution');

const summary = { image } as BinaryAnalysisSummary;
analyses = 0;
const cached = await resolveBinaryExecutionTarget(file, summary, async () => {
  analyses += 1;
  return { kind: 'binary', file, image };
});
assert(analyses === 0, 'existing analysis summary must be reused without re-analysis');
assert(cached.kind === 'binary' && cached.image === image, 'cached summary must resolve the same executable target');

const textFile: ProjectFile = {
  id: 'notes',
  path: 'notes.txt',
  name: 'notes.txt',
  kind: 'text',
  language: 'text',
  text: 'not executable',
  size: 14,
  updatedAt: 1
};
let rejected = false;
try {
  await resolveBinaryExecutionTarget(textFile, null, async () => ({ kind: 'binary', file, image }));
} catch {
  rejected = true;
}
assert(rejected, 'non-binary files must remain fail-closed');

console.log('execution target resolution smoke: PASS (Run analyzes on demand, reuses cached summaries, and restarts terminal sessions)');
