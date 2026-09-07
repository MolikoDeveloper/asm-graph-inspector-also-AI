import { inspectElfSymbolVersions, type ElfSymbolVersionSummary } from '../binary/elfSymbolVersions';
import type { RuntimeDependencyClosure, MaterializedRuntimeModule } from './runtimeDependencies';

export type RuntimeSymbolVersionIssueKind =
  | 'requester-metadata-invalid'
  | 'provider-unresolved'
  | 'provider-metadata-invalid'
  | 'version-missing';

export interface RuntimeSymbolVersionIssue {
  kind: RuntimeSymbolVersionIssueKind;
  requester: string;
  library: string | null;
  version: string | null;
  provider: string | null;
  detail: string;
}

export interface RuntimeSymbolVersionValidation {
  compatible: boolean;
  requesterCount: number;
  checkedRequirements: number;
  issues: RuntimeSymbolVersionIssue[];
}

type VersionInspector = (buffer: ArrayBuffer) => ElfSymbolVersionSummary;

function aliases(module: MaterializedRuntimeModule): Set<string> {
  return new Set([
    module.requestedName,
    module.fileName,
    module.soname
  ].filter((value): value is string => !!value));
}

function findProvider(closure: RuntimeDependencyClosure, library: string): MaterializedRuntimeModule | null {
  return closure.modules.find((module) => aliases(module).has(library)) ?? null;
}

interface Requester {
  name: string;
  bytes: ArrayBuffer;
}

/**
 * Validate GNU DT_VERNEED requirements against the exact runtime modules that
 * were selected from Global Dependencies. This is intentionally producer
 * agnostic: the verdict comes only from the requesting ELF metadata and the
 * version definitions exported by the concrete provider ELF bytes.
 */
export function validateRuntimeSymbolVersions(
  rootName: string,
  rootBytes: ArrayBuffer,
  closure: RuntimeDependencyClosure,
  inspect: VersionInspector = inspectElfSymbolVersions
): RuntimeSymbolVersionValidation {
  const requesters: Requester[] = [
    { name: rootName, bytes: rootBytes },
    ...closure.modules.map((module) => ({ name: module.fileName, bytes: module.bytes }))
  ];
  const issues: RuntimeSymbolVersionIssue[] = [];
  const providerSummaries = new Map<ArrayBuffer, ElfSymbolVersionSummary | Error>();
  let checkedRequirements = 0;

  const providerSummary = (module: MaterializedRuntimeModule): ElfSymbolVersionSummary | Error => {
    const cached = providerSummaries.get(module.bytes);
    if (cached) return cached;
    try {
      const summary = inspect(module.bytes);
      providerSummaries.set(module.bytes, summary);
      return summary;
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      providerSummaries.set(module.bytes, normalized);
      return normalized;
    }
  };

  for (const requester of requesters) {
    let summary: ElfSymbolVersionSummary;
    try {
      summary = inspect(requester.bytes);
    } catch (error: unknown) {
      issues.push({
        kind: 'requester-metadata-invalid',
        requester: requester.name,
        library: null,
        version: null,
        provider: null,
        detail: `${requester.name} GNU symbol-version metadata could not be inspected: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    for (const requirement of summary.requirements) {
      const provider = findProvider(closure, requirement.library);
      if (!provider) {
        for (const version of requirement.versions) {
          checkedRequirements += 1;
          issues.push({
            kind: 'provider-unresolved',
            requester: requester.name,
            library: requirement.library,
            version,
            provider: null,
            detail: `${requester.name} requires ${requirement.library}@${version}, but no selected Global Dependency provides ${requirement.library}.`
          });
        }
        continue;
      }

      const provided = providerSummary(provider);
      if (provided instanceof Error) {
        for (const version of requirement.versions) {
          checkedRequirements += 1;
          issues.push({
            kind: 'provider-metadata-invalid',
            requester: requester.name,
            library: requirement.library,
            version,
            provider: provider.fileName,
            detail: `${requester.name} requires ${requirement.library}@${version}, but selected ${provider.fileName} GNU symbol-version definitions could not be inspected: ${provided.message}`
          });
        }
        continue;
      }

      const definitions = new Set(provided.definitions);
      for (const version of requirement.versions) {
        checkedRequirements += 1;
        if (definitions.has(version)) continue;
        issues.push({
          kind: 'version-missing',
          requester: requester.name,
          library: requirement.library,
          version,
          provider: provider.fileName,
          detail: `${requester.name} requires ${requirement.library}@${version}, but selected ${provider.fileName} does not define ${version}.`
        });
      }
    }
  }

  return {
    compatible: issues.length === 0,
    requesterCount: requesters.length,
    checkedRequirements,
    issues
  };
}

export function describeRuntimeSymbolVersionFailure(validation: RuntimeSymbolVersionValidation): string {
  if (validation.compatible) {
    return `GNU symbol-version compatibility satisfied (${validation.checkedRequirements.toLocaleString()} requirement(s) checked across ${validation.requesterCount.toLocaleString()} ELF image(s)).`;
  }
  const visible = validation.issues.slice(0, 8).map((issue) => issue.detail);
  const omitted = validation.issues.length - visible.length;
  return `Runtime GNU symbol-version compatibility failed. ${visible.join(' ')}${omitted > 0 ? ` ${omitted.toLocaleString()} additional incompatibility issue(s) omitted.` : ''}`;
}
