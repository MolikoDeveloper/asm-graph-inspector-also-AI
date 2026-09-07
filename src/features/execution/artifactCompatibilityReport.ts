import type { LoadedImage } from '../binary/model';
import { inspectElfHeader } from '../binary/elfParser';
import type { ProjectFile } from '../project/model';
import type { BlinkIsaAudit } from './blinkIsaPreflight';
import type { ExecutionSnapshot, ExecutionSupport } from './model';
import type { RuntimeDependencyClosure } from './runtimeDependencies';
import type { BlinkRuntimeIsaAudit } from './runtimeIsaAudit';
import type { RuntimeSymbolVersionValidation } from './runtimeSymbolVersions';

export const ARTIFACT_COMPATIBILITY_REPORT_SCHEMA = 'asm-graph.artifact-compatibility/v1' as const;

export type ArtifactCompatibilityCheckStatus = 'pass' | 'fail' | 'unknown' | 'not-applicable';
export type ArtifactCompatibilityCheckId =
  | 'elf-format'
  | 'architecture'
  | 'execution-backend'
  | 'cpu-isa'
  | 'runtime-isa'
  | 'interpreter'
  | 'dependency-closure'
  | 'symbol-versions'
  | 'runtime-services'
  | 'observed-runtime';

export interface ArtifactCompatibilityCheck {
  id: ArtifactCompatibilityCheckId;
  label: string;
  status: ArtifactCompatibilityCheckStatus;
  summary: string;
  evidence: string[];
}

export interface ArtifactCompatibilityReport {
  schema: typeof ARTIFACT_COMPATIBILITY_REPORT_SCHEMA;
  targetFileId: string;
  targetName: string;
  backend: string | null;
  /** false = known incompatible, true = all applicable checks proven, null = incomplete evidence. */
  compatible: boolean | null;
  checks: ArtifactCompatibilityCheck[];
  blockerIds: ArtifactCompatibilityCheckId[];
}

export interface ArtifactCompatibilityReportInput {
  file: ProjectFile;
  image?: LoadedImage | null;
  executionSupport?: ExecutionSupport | null;
  isaAudit?: BlinkIsaAudit | null;
  runtimeIsa?: BlinkRuntimeIsaAudit | null;
  runtimeClosure?: RuntimeDependencyClosure | null;
  runtimeClosureError?: string | null;
  symbolVersions?: RuntimeSymbolVersionValidation | null;
  snapshot?: ExecutionSnapshot | null;
}

function check(
  id: ArtifactCompatibilityCheckId,
  label: string,
  status: ArtifactCompatibilityCheckStatus,
  summary: string,
  evidence: string[] = []
): ArtifactCompatibilityCheck {
  return { id, label, status, summary, evidence };
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function runtimeIsaCheck(runtimeIsa: BlinkRuntimeIsaAudit | null | undefined): ArtifactCompatibilityCheck {
  if (!runtimeIsa) {
    return check('runtime-isa', 'Runtime dependency ISA', 'unknown', 'Materialized PT_INTERP/DT_NEEDED executable bytes have not been inventoried yet.');
  }
  if (!runtimeIsa.compatible) {
    const blockers = runtimeIsa.modules.filter((module) => module.blockingEvidence !== null);
    return check(
      'runtime-isa',
      'Runtime dependency ISA',
      'fail',
      `${runtimeIsa.blockingModuleCount.toLocaleString()} runtime module(s) contain unsupported ISA on a mandatory interpreter-entry path.`,
      blockers.slice(0, 8).map((module) => {
        const evidence = module.blockingEvidence!;
        return `${module.fileName}: 0x${evidence.address.toString(16)} ${evidence.mnemonic}${evidence.operands ? ` ${evidence.operands}` : ''}`;
      })
    );
  }
  if (runtimeIsa.advisoryModuleCount > 0) {
    const advisory = runtimeIsa.modules.filter((module) => module.unsupportedFamilies.length > 0 && module.blockingEvidence === null);
    return check(
      'runtime-isa',
      'Runtime dependency ISA',
      'pass',
      `${runtimeIsa.scannedModules.toLocaleString()} runtime module(s) scanned; ${runtimeIsa.advisoryModuleCount.toLocaleString()} contain non-blocking optional/dispatched ISA evidence.`,
      [
        ...advisory.slice(0, 6).map((module) => `${module.fileName}: ${module.unsupportedFamilies.join(', ')}`),
        'Whole-image DSO hits are advisory because GNU IFUNC/multiarch CPU dispatch can keep those implementations dormant. Observed SIGILL + RIP/module evidence is authoritative if they execute.'
      ]
    );
  }
  return check(
    'runtime-isa',
    'Runtime dependency ISA',
    runtimeIsa.scannedModules ? 'pass' : 'not-applicable',
    runtimeIsa.scannedModules
      ? `${runtimeIsa.scannedModules.toLocaleString()} materialized runtime module(s) scanned with no unsupported ISA evidence.`
      : 'No materialized PT_INTERP/DT_NEEDED runtime modules require ISA inventory.'
  );
}

function runtimeServiceCheck(snapshot: ExecutionSnapshot | null | undefined): ArtifactCompatibilityCheck {
  if (!snapshot || snapshot.status === 'idle' || snapshot.status === 'ready') {
    return check('runtime-services', 'Runtime services', 'unknown', 'No guest runtime service evidence has been observed yet.');
  }

  const unsupported = snapshot.providerDiagnostics.filter((item) =>
    (item.level === 'warning' || item.level === 'error') && /unsupported syscall|not implemented|unsupported runtime/i.test(item.message)
  );
  if (unsupported.length) {
    return check(
      'runtime-services',
      'Runtime services',
      'fail',
      `${unsupported.length.toLocaleString()} unsupported runtime service diagnostic(s) were observed.`,
      unsupported.slice(0, 8).map((item) => `${item.level}: ${item.message}${item.count > 1 ? ` ×${item.count}` : ''}`)
    );
  }

  if (snapshot.status === 'exited') {
    return check(
      'runtime-services',
      'Runtime services',
      'pass',
      'The observed execution exited without an unsupported runtime-service diagnostic.',
      ['This is observed-path evidence only; unexecuted syscalls/environment services are not inferred compatible.']
    );
  }

  return check(
    'runtime-services',
    'Runtime services',
    'unknown',
    'No unsupported runtime service has been observed so far, but execution has not completed.'
  );
}

function observedRuntimeCheck(snapshot: ExecutionSnapshot | null | undefined): ArtifactCompatibilityCheck {
  if (!snapshot || snapshot.status === 'idle' || snapshot.status === 'ready') {
    return check('observed-runtime', 'Observed runtime', 'unknown', 'The artifact has not completed an observed execution.');
  }
  if (snapshot.crash) {
    const crash = snapshot.crash;
    return check(
      'observed-runtime',
      'Observed runtime',
      'fail',
      `${crash.signalName} was observed at ${crash.runtimeAddress !== null ? `RIP 0x${crash.runtimeAddress.toString(16)}` : 'an unresolved RIP'}.`,
      [
        crash.imageName ? `image=${crash.imageName}${crash.imageAddress !== null ? ` elf=0x${crash.imageAddress.toString(16)}` : ''}` : 'image=unresolved',
        crash.instruction ? `instruction=${crash.instruction.mnemonic}${crash.instruction.operands ? ` ${crash.instruction.operands}` : ''}` : 'instruction=unresolved'
      ]
    );
  }
  if (snapshot.status === 'trapped' || snapshot.status === 'halted') {
    return check(
      'observed-runtime',
      'Observed runtime',
      'fail',
      snapshot.trapReason ?? `Execution ended in ${snapshot.status}.`
    );
  }
  if (snapshot.status === 'exited') {
    return check(
      'observed-runtime',
      'Observed runtime',
      'pass',
      `The observed process exited normally through the execution provider with code ${snapshot.exitCode ?? 0}.`,
      snapshot.exitCode === 0 ? [] : ['A non-zero application exit code is not by itself a sandbox compatibility failure.']
    );
  }
  return check('observed-runtime', 'Observed runtime', 'unknown', `Execution is currently ${snapshot.status}.`);
}

/**
 * Build a producer-agnostic compatibility snapshot. It deliberately never asks
 * which compiler/language created the artifact: every verdict is derived from
 * ELF bytes, selected runtime dependencies, sandbox capability evidence, or an
 * observed execution result.
 */
export function buildArtifactCompatibilityReport(input: ArtifactCompatibilityReportInput): ArtifactCompatibilityReport {
  const {
    file,
    image = null,
    executionSupport = null,
    isaAudit = null,
    runtimeIsa = null,
    runtimeClosure = null,
    runtimeClosureError = null,
    symbolVersions = null,
    snapshot = null
  } = input;
  const header = inspectElfHeader(file.kind === 'binary' ? file.bytes : undefined);
  const checks: ArtifactCompatibilityCheck[] = [];

  checks.push(header.valid
    ? check(
        'elf-format',
        'ELF format',
        header.elfClass === 64 && header.littleEndian === true ? 'pass' : 'fail',
        `ELF${header.elfClass ?? '?'} ${header.littleEndian ? 'little-endian' : 'non-little-endian'} ${header.kind ?? 'unknown'}.`,
        [`machine=${header.machine ?? 'unknown'}`, `entry=${header.entry !== undefined ? `0x${header.entry.toString(16)}` : 'unknown'}`]
      )
    : check('elf-format', 'ELF format', 'fail', header.reason ?? 'Artifact is not a valid ELF file.'));

  checks.push(header.valid
    ? check(
        'architecture',
        'Machine architecture',
        header.elfClass === 64 && header.littleEndian === true && header.architecture === 'x86-64' ? 'pass' : 'fail',
        `${header.architecture ?? 'unknown'} / ELF${header.elfClass ?? '?'} / ${header.littleEndian ? 'little-endian' : 'non-little-endian'}.`,
        ['Current Blink Linux userspace backend contract: little-endian ELF64 x86-64.']
      )
    : check('architecture', 'Machine architecture', 'unknown', 'Architecture cannot be validated until the ELF header is valid.'));

  if (!executionSupport) {
    checks.push(check('execution-backend', 'Execution backend', 'unknown', 'No execution-provider decision is available yet.'));
  } else if (!executionSupport.supported || !executionSupport.provider) {
    checks.push(check('execution-backend', 'Execution backend', 'fail', executionSupport.reasons.join(' ') || 'No execution backend accepts this artifact.'));
  } else {
    checks.push(check('execution-backend', 'Execution backend', 'pass', `Selected ${executionSupport.provider}.`, executionSupport.notes.slice()));
  }

  if (!isaAudit) {
    checks.push(check('cpu-isa', 'CPU ISA', 'unknown', 'Executable-byte ISA audit has not completed.'));
  } else if (isaAudit.compatible) {
    checks.push(check('cpu-isa', 'CPU ISA', 'pass', `${isaAudit.scannedInstructions.toLocaleString()} executable instruction(s) decoded with no positively identified ISA outside ${isaAudit.profile}.`));
  } else {
    const first = isaAudit.evidence[0];
    checks.push(check(
      'cpu-isa',
      'CPU ISA',
      'fail',
      `Executable bytes require unsupported families: ${isaAudit.unsupportedFamilies.join(', ')}.`,
      first ? [`first static evidence: 0x${first.address.toString(16)} ${first.mnemonic}${first.operands ? ` ${first.operands}` : ''}`] : []
    ));
  }

  checks.push(runtimeIsaCheck(runtimeIsa));

  if (!image) {
    checks.push(check('interpreter', 'ELF interpreter', 'unknown', 'Loaded-image metadata is unavailable.'));
    checks.push(check('dependency-closure', 'Dependency closure', 'unknown', 'Loaded-image metadata is unavailable.'));
  } else if (!image.interpreter) {
    checks.push(check('interpreter', 'ELF interpreter', 'not-applicable', 'No PT_INTERP is requested by this artifact.'));
    checks.push(image.neededLibraries.length
      ? runtimeClosureError
        ? check('dependency-closure', 'Dependency closure', 'fail', runtimeClosureError)
        : runtimeClosure
          ? check('dependency-closure', 'Dependency closure', 'pass', `${runtimeClosure.modules.length.toLocaleString()} runtime module(s) materialized for ${image.neededLibraries.length.toLocaleString()} direct DT_NEEDED entr${image.neededLibraries.length === 1 ? 'y' : 'ies'}.`)
          : check('dependency-closure', 'Dependency closure', 'unknown', `${image.neededLibraries.length.toLocaleString()} DT_NEEDED entr${image.neededLibraries.length === 1 ? 'y' : 'ies'} await materialization.`)
      : check('dependency-closure', 'Dependency closure', 'not-applicable', 'No DT_NEEDED libraries are requested.'));
  } else {
    if (runtimeClosureError) {
      checks.push(check('interpreter', 'ELF interpreter', 'fail', `PT_INTERP ${image.interpreter} could not be materialized.`, [runtimeClosureError]));
      checks.push(check('dependency-closure', 'Dependency closure', 'fail', runtimeClosureError));
    } else if (runtimeClosure) {
      const requestedInterpreter = basename(image.interpreter);
      const selectedInterpreter = runtimeClosure.interpreterPath ? basename(runtimeClosure.interpreterPath) : null;
      checks.push(check(
        'interpreter',
        'ELF interpreter',
        selectedInterpreter === requestedInterpreter ? 'pass' : 'fail',
        selectedInterpreter === requestedInterpreter
          ? `PT_INTERP ${image.interpreter} resolved from Global Dependencies.`
          : `PT_INTERP ${image.interpreter} did not resolve to the selected runtime interpreter.`
      ));
      checks.push(check(
        'dependency-closure',
        'Dependency closure',
        'pass',
        `${runtimeClosure.modules.length.toLocaleString()} interpreter/dependency module(s) were materialized recursively.`,
        runtimeClosure.modules.slice(0, 12).map((module) => `${module.requestedName} -> ${module.fileName}${module.soname ? ` (${module.soname})` : ''}`)
      ));
    } else {
      checks.push(check('interpreter', 'ELF interpreter', 'unknown', `PT_INTERP ${image.interpreter} has not been materialized yet.`));
      checks.push(check('dependency-closure', 'Dependency closure', 'unknown', `${image.neededLibraries.length.toLocaleString()} direct DT_NEEDED entr${image.neededLibraries.length === 1 ? 'y' : 'ies'} await recursive resolution.`));
    }
  }

  if (!symbolVersions) {
    checks.push(check('symbol-versions', 'GNU symbol versions', 'unknown', 'DT_VERNEED requirements have not yet been compared with selected provider DT_VERDEF definitions.'));
  } else if (symbolVersions.compatible) {
    checks.push(check(
      'symbol-versions',
      'GNU symbol versions',
      symbolVersions.checkedRequirements ? 'pass' : 'not-applicable',
      symbolVersions.checkedRequirements
        ? `${symbolVersions.checkedRequirements.toLocaleString()} required GNU symbol version(s) are provided by the selected runtime closure.`
        : 'No versioned GNU symbol requirements were present in the inspected runtime images.'
    ));
  } else {
    checks.push(check(
      'symbol-versions',
      'GNU symbol versions',
      'fail',
      `${symbolVersions.issues.length.toLocaleString()} symbol-version incompatibility issue(s) were found.`,
      symbolVersions.issues.slice(0, 8).map((issue) => issue.detail)
    ));
  }

  checks.push(runtimeServiceCheck(snapshot));
  checks.push(observedRuntimeCheck(snapshot));

  const blockerIds = checks.filter((item) => item.status === 'fail').map((item) => item.id);
  const requiredIncomplete = checks.some((item) => item.status === 'unknown');
  const compatible = blockerIds.length ? false : requiredIncomplete ? null : true;

  return {
    schema: ARTIFACT_COMPATIBILITY_REPORT_SCHEMA,
    targetFileId: file.id,
    targetName: file.name,
    backend: executionSupport?.provider ?? snapshot?.provider ?? null,
    compatible,
    checks,
    blockerIds
  };
}
