import { executableBytesForRange, parseElfImage } from '../binary/elfParser';
import { loadCapstone } from '../capstone/capstoneLoader';
import { decodeX86_64 } from '../capstone/capstoneDecoder';
import type { ProjectFile } from '../project/model';
import {
  auditBlinkIsaForFile,
  blinkUnsupportedIsaFamily,
  type BlinkIsaAudit,
  type BlinkIsaEvidence,
  type BlinkUnsupportedIsaFamily
} from './blinkIsaPreflight';
import type { MaterializedRuntimeModule, RuntimeDependencyClosure } from './runtimeDependencies';

export type BlinkRuntimeIsaRole = 'interpreter' | 'dependency';

export interface BlinkRuntimeModuleIsaAudit {
  requestedName: string;
  fileName: string;
  soname: string | null;
  role: BlinkRuntimeIsaRole;
  scannedInstructions: number;
  decodedBytes: number;
  skippedBytes: number;
  unsupportedFamilies: BlinkUnsupportedIsaFamily[];
  evidence: BlinkIsaEvidence[];
  /**
   * A whole-image hit is inventory only for runtime modules. glibc and other
   * ELF DSOs legitimately ship CPU-dispatched/IFUNC implementations that are
   * never selected on a baseline CPU. Blocking requires evidence on a path we
   * know is unconditionally entered by the process contract.
   */
  advisoryOnly: boolean;
  blockingEvidence: BlinkIsaEvidence | null;
}

export interface BlinkRuntimeIsaAudit {
  compatible: boolean;
  scannedModules: number;
  scannedInstructions: number;
  decodedBytes: number;
  skippedBytes: number;
  advisoryModuleCount: number;
  blockingModuleCount: number;
  modules: BlinkRuntimeModuleIsaAudit[];
}

export interface BlinkRuntimeIsaAuditDependencies {
  auditFile?: (file: ProjectFile) => Promise<BlinkIsaAudit>;
  auditInterpreterEntry?: (module: MaterializedRuntimeModule) => Promise<BlinkIsaEvidence | null>;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function moduleRole(module: MaterializedRuntimeModule, interpreterPath: string | null): BlinkRuntimeIsaRole {
  if (!interpreterPath) return 'dependency';
  const interpreterName = basename(interpreterPath);
  return module.requestedName === interpreterName || module.fileName === interpreterName || module.soname === interpreterName
    ? 'interpreter'
    : 'dependency';
}

function moduleProjectFile(module: MaterializedRuntimeModule): ProjectFile {
  return {
    id: `runtime-isa:${module.sourceId}:${module.fileName}`,
    path: module.fileName,
    name: module.fileName,
    kind: 'binary',
    language: 'binary',
    bytes: module.bytes,
    size: module.bytes.byteLength,
    updatedAt: 0
  };
}

/**
 * The ELF interpreter entry point is a mandatory process path: Blink transfers
 * control there before normal dynamic loading begins. It is therefore safe to
 * reject a positively decoded unsupported instruction exactly at that entry.
 *
 * We deliberately do NOT generalize this to arbitrary code reachable through
 * branches inside ld.so/libc. CPU dispatch and GNU IFUNC make static branch
 * reachability insufficient to prove that an unsupported implementation will
 * execute on the advertised Blink CPU.
 */
export async function auditBlinkInterpreterEntryIsa(module: MaterializedRuntimeModule): Promise<BlinkIsaEvidence | null> {
  const file = moduleProjectFile(module);
  const image = parseElfImage(file.id, file.path, module.bytes);
  if (!image.entry) return null;

  const bytes = executableBytesForRange(image, module.bytes, image.entry, 15);
  if (!bytes.length) return null;
  const capstone = await loadCapstone();
  const instruction = decodeX86_64(capstone, bytes, image.entry, { maxInstructions: 1 })[0];
  if (!instruction || instruction.address !== image.entry) return null;

  const family = blinkUnsupportedIsaFamily({ bytes: instruction.bytes, mnemonic: instruction.mnemonic });
  if (!family) return null;
  const segment = image.segments.find((candidate) =>
    candidate.executable &&
    image.entry >= candidate.virtualAddress &&
    image.entry < candidate.virtualAddress + candidate.fileSize
  );
  return {
    family,
    address: instruction.address,
    mnemonic: instruction.mnemonic,
    operands: instruction.operands,
    bytes: instruction.bytes.slice(),
    sectionName: segment ? `PT_LOAD#${segment.index} entry` : 'ELF entry'
  };
}

/**
 * Inventory the exact materialized PT_INTERP + recursive DT_NEEDED bytes.
 *
 * Policy is intentionally asymmetric:
 * - the main guest ELF is audited strictly elsewhere;
 * - runtime DSOs are scanned in full for diagnostics, but unsupported static
 *   bytes are advisory because multiarch/IFUNC dispatch can make them dormant;
 * - an unsupported instruction exactly at PT_INTERP's ELF entry is a blocker,
 *   because that instruction is unconditionally entered by the process model;
 * - if a runtime DSO later actually executes an unsupported instruction, Blink
 *   SIGILL capture (RIP + module + bytes + Capstone) is authoritative.
 */
export async function auditBlinkRuntimeDependencyIsa(
  closure: RuntimeDependencyClosure,
  dependencies: BlinkRuntimeIsaAuditDependencies = {}
): Promise<BlinkRuntimeIsaAudit> {
  if (!closure.modules.length) {
    return {
      compatible: true,
      scannedModules: 0,
      scannedInstructions: 0,
      decodedBytes: 0,
      skippedBytes: 0,
      advisoryModuleCount: 0,
      blockingModuleCount: 0,
      modules: []
    };
  }

  const auditFile = dependencies.auditFile ?? ((file: ProjectFile) => auditBlinkIsaForFile(file, { maxEvidence: 12 }));
  const auditInterpreterEntry = dependencies.auditInterpreterEntry ?? auditBlinkInterpreterEntryIsa;
  const modules: BlinkRuntimeModuleIsaAudit[] = [];

  for (const module of closure.modules) {
    const role = moduleRole(module, closure.interpreterPath);
    const audit = await auditFile(moduleProjectFile(module));
    const blockingEvidence = role === 'interpreter'
      ? await auditInterpreterEntry(module)
      : null;
    modules.push({
      requestedName: module.requestedName,
      fileName: module.fileName,
      soname: module.soname,
      role,
      scannedInstructions: audit.scannedInstructions,
      decodedBytes: audit.decodedBytes,
      skippedBytes: audit.skippedBytes,
      unsupportedFamilies: audit.unsupportedFamilies.slice(),
      evidence: audit.evidence.slice(),
      advisoryOnly: blockingEvidence === null,
      blockingEvidence
    });
  }

  const blockingModuleCount = modules.filter((module) => module.blockingEvidence !== null).length;
  return {
    compatible: blockingModuleCount === 0,
    scannedModules: modules.length,
    scannedInstructions: modules.reduce((sum, module) => sum + module.scannedInstructions, 0),
    decodedBytes: modules.reduce((sum, module) => sum + module.decodedBytes, 0),
    skippedBytes: modules.reduce((sum, module) => sum + module.skippedBytes, 0),
    advisoryModuleCount: modules.filter((module) => module.unsupportedFamilies.length > 0 && module.blockingEvidence === null).length,
    blockingModuleCount,
    modules
  };
}

function evidenceLabel(evidence: BlinkIsaEvidence): string {
  const bytes = evidence.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  return `0x${evidence.address.toString(16)} ${evidence.mnemonic}${evidence.operands ? ` ${evidence.operands}` : ''} [${bytes}]`;
}

export function describeBlinkRuntimeIsaFailure(audit: BlinkRuntimeIsaAudit): string {
  const blockers = audit.modules.filter((module) => module.blockingEvidence !== null);
  if (!blockers.length) {
    return `Runtime ISA inventory is compatible: ${audit.scannedModules.toLocaleString()} module(s) scanned; ${audit.advisoryModuleCount.toLocaleString()} module(s) contain non-blocking CPU-dispatched/optional ISA evidence.`;
  }
  const details = blockers.slice(0, 4).map((module) =>
    `${module.fileName} (${module.role}) enters an unsupported instruction at ${evidenceLabel(module.blockingEvidence!)}.`
  );
  return `Runtime dependency ISA compatibility failed for Blink. ${details.join(' ')} Whole-image ISA hits elsewhere in shared libraries remain advisory because GNU IFUNC/multiarch dispatch may keep optional implementations unreachable; this rejection is based only on mandatory interpreter-entry evidence.`;
}

export function describeBlinkRuntimeIsaAdvisory(audit: BlinkRuntimeIsaAudit): string | null {
  const advisory = audit.modules.filter((module) => module.unsupportedFamilies.length > 0 && module.blockingEvidence === null);
  if (!advisory.length) return null;
  const visible = advisory.slice(0, 5).map((module) => `${module.fileName}: ${module.unsupportedFamilies.join(', ')}`);
  const omitted = advisory.length - visible.length;
  return `Runtime ISA inventory scanned ${audit.scannedModules.toLocaleString()} materialized module(s). Static unsupported ISA bytes were found in ${advisory.length.toLocaleString()} runtime module(s) (${visible.join('; ')}${omitted > 0 ? `; +${omitted.toLocaleString()} more` : ''}) but are non-blocking inventory: shared libraries/loaders can contain CPU-dispatched or GNU IFUNC implementations that Blink's advertised CPU will not select. An observed SIGILL with RIP/module attribution remains authoritative if such code actually executes.`;
}
