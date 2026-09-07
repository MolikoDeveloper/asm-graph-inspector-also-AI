import type { LoadedImage } from '../binary/model';
import type { ProjectFile } from '../project/model';
import {
  materializeRuntimeDependencyClosure,
  type RuntimeDependencyClosure
} from './runtimeDependencies';
import {
  validateRuntimeSymbolVersions,
  type RuntimeSymbolVersionValidation
} from './runtimeSymbolVersions';

export const BLINK_RUNTIME_ENVIRONMENT_SCHEMA = 'asm-graph.blink-runtime-environment/v1' as const;

export interface PreparedBlinkRuntimeEnvironment {
  schema: typeof BLINK_RUNTIME_ENVIRONMENT_SCHEMA;
  targetFileId: string;
  targetName: string;
  targetUpdatedAt: number;
  targetSize: number;
  interpreterPath: string | null;
  directNeeded: string[];
  closure: RuntimeDependencyClosure;
  symbolVersions: RuntimeSymbolVersionValidation;
}

export interface BlinkRuntimeEnvironmentPreparationDependencies {
  materialize?: (
    interpreterPath: string | null,
    directNeeded: string[]
  ) => Promise<RuntimeDependencyClosure>;
  validateSymbolVersions?: (
    rootName: string,
    rootBytes: ArrayBuffer,
    closure: RuntimeDependencyClosure
  ) => RuntimeSymbolVersionValidation;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Resolve the dynamic Linux userspace environment exactly once. The returned
 * object is the shared evidence/mount contract for compatibility validation and
 * Blink process initialization; callers must not independently rematerialize
 * Global Dependencies for the same launch.
 */
export async function prepareBlinkRuntimeEnvironment(
  file: ProjectFile,
  image: LoadedImage,
  dependencies: BlinkRuntimeEnvironmentPreparationDependencies = {}
): Promise<PreparedBlinkRuntimeEnvironment> {
  if (file.kind !== 'binary' || !file.bytes) {
    throw new Error('Blink runtime preparation requires authoritative ELF bytes.');
  }

  const materialize = dependencies.materialize ?? materializeRuntimeDependencyClosure;
  const validateSymbolVersions = dependencies.validateSymbolVersions ?? validateRuntimeSymbolVersions;
  const directNeeded = image.neededLibraries.slice();
  const closure = await materialize(image.interpreter, directNeeded);
  const symbolVersions = validateSymbolVersions(file.name, file.bytes, closure);

  return {
    schema: BLINK_RUNTIME_ENVIRONMENT_SCHEMA,
    targetFileId: file.id,
    targetName: file.name,
    targetUpdatedAt: file.updatedAt,
    targetSize: file.size,
    interpreterPath: image.interpreter,
    directNeeded,
    closure,
    symbolVersions
  };
}

/**
 * Fail closed if a prepared environment is accidentally reused after the
 * binary or its dynamic-link contract changed. This protects symbol-version
 * evidence and the exact selected Global Dependency bytes from going stale.
 */
export function assertPreparedBlinkRuntimeEnvironmentMatches(
  file: ProjectFile,
  image: LoadedImage,
  environment: PreparedBlinkRuntimeEnvironment
): void {
  if (environment.schema !== BLINK_RUNTIME_ENVIRONMENT_SCHEMA) {
    throw new Error(`Prepared Blink runtime environment schema ${String(environment.schema)} is unsupported.`);
  }
  if (
    environment.targetFileId !== file.id ||
    environment.targetUpdatedAt !== file.updatedAt ||
    environment.targetSize !== file.size
  ) {
    throw new Error('Prepared Blink runtime environment is stale for the selected binary artifact. Prepare the process again.');
  }
  if (environment.interpreterPath !== image.interpreter || !sameStrings(environment.directNeeded, image.neededLibraries)) {
    throw new Error('Prepared Blink runtime environment does not match the selected ELF PT_INTERP/DT_NEEDED contract. Prepare the process again.');
  }
}
