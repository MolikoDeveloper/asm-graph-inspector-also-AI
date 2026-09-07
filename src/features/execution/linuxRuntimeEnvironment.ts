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

export const LINUX_RUNTIME_ENVIRONMENT_SCHEMA = 'asm-graph.linux-runtime-environment/v1' as const;

export interface PreparedLinuxRuntimeEnvironment {
  schema: typeof LINUX_RUNTIME_ENVIRONMENT_SCHEMA;
  targetFileId: string;
  targetName: string;
  targetUpdatedAt: number;
  targetSize: number;
  interpreterPath: string | null;
  directNeeded: string[];
  closure: RuntimeDependencyClosure;
  symbolVersions: RuntimeSymbolVersionValidation;
}

export interface LinuxRuntimeEnvironmentPreparationDependencies {
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
 * Producer-agnostic Linux userspace preparation shared by every guest execution
 * backend. The dependency closure is materialized exactly once from Global
 * Dependencies and then becomes immutable launch evidence for the selected ELF.
 */
export async function prepareLinuxRuntimeEnvironment(
  file: ProjectFile,
  image: LoadedImage,
  dependencies: LinuxRuntimeEnvironmentPreparationDependencies = {}
): Promise<PreparedLinuxRuntimeEnvironment> {
  if (file.kind !== 'binary' || !file.bytes) {
    throw new Error('Linux runtime preparation requires authoritative ELF bytes.');
  }

  const materialize = dependencies.materialize ?? materializeRuntimeDependencyClosure;
  const validateSymbolVersions = dependencies.validateSymbolVersions ?? validateRuntimeSymbolVersions;
  const directNeeded = image.neededLibraries.slice();
  const closure = await materialize(image.interpreter, directNeeded);
  const symbolVersions = validateSymbolVersions(file.name, file.bytes, closure);

  return {
    schema: LINUX_RUNTIME_ENVIRONMENT_SCHEMA,
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

export function assertPreparedLinuxRuntimeEnvironmentMatches(
  file: ProjectFile,
  image: LoadedImage,
  environment: PreparedLinuxRuntimeEnvironment
): void {
  if (environment.schema !== LINUX_RUNTIME_ENVIRONMENT_SCHEMA) {
    throw new Error(`Prepared Linux runtime environment schema ${String(environment.schema)} is unsupported.`);
  }
  if (
    environment.targetFileId !== file.id ||
    environment.targetUpdatedAt !== file.updatedAt ||
    environment.targetSize !== file.size
  ) {
    throw new Error('Prepared Linux runtime environment is stale for the selected binary artifact. Prepare the process again.');
  }
  if (environment.interpreterPath !== image.interpreter || !sameStrings(environment.directNeeded, image.neededLibraries)) {
    throw new Error('Prepared Linux runtime environment does not match the selected ELF PT_INTERP/DT_NEEDED contract. Prepare the process again.');
  }
}
