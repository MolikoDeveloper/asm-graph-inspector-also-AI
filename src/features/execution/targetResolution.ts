import type { BinaryAnalysisSummary } from '../binary/model';
import type { ProjectFile } from '../project/model';
import type { ExecutionStatus, ExecutionTarget } from './model';

export type BinaryExecutionTargetAnalyzer = (file: ProjectFile) => Promise<ExecutionTarget>;

/**
 * UI execution actions may be offered before background binary analysis has
 * completed. A binary ProjectFile is sufficient evidence to attempt the
 * authoritative ELF analysis on demand; support/provider selection is decided
 * only after that analysis has produced a LoadedImage.
 */
export function canResolveExecutionTargetFromFile(file: ProjectFile | null): boolean {
  if (!file) return false;
  if (file.kind === 'binary') return file.bytes instanceof ArrayBuffer;
  return file.kind === 'text' && file.language === 'asm';
}

/** Run continues a paused process, but terminal sessions must be recreated. */
export function shouldRestartRunFromStatus(status: ExecutionStatus): boolean {
  return status === 'exited' || status === 'halted' || status === 'trapped';
}

/**
 * Return an already-analyzed target when possible, otherwise perform the exact
 * same authoritative binary analysis used by the normal analysis UI. This is
 * intentionally independent of React so Run/F6/terminal paths can share the
 * invariant that pre-analysis is an optimization, never a prerequisite.
 */
export async function resolveBinaryExecutionTarget(
  file: ProjectFile,
  summary: BinaryAnalysisSummary | null | undefined,
  analyze: BinaryExecutionTargetAnalyzer
): Promise<ExecutionTarget> {
  if (file.kind !== 'binary' || !(file.bytes instanceof ArrayBuffer)) {
    throw new Error(`${file.path} is not an executable binary artifact.`);
  }
  if (summary) return { kind: 'binary', file, image: summary.image };

  const target = await analyze(file);
  if (target.kind !== 'binary' || target.file.id !== file.id) {
    throw new Error(`Binary analysis for ${file.path} did not return its executable target.`);
  }
  return target;
}
