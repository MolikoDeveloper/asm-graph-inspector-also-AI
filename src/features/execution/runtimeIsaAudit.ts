import { inspectElfHeader } from '../binary/elfParser';
import { loadCapstone } from '../capstone/capstoneLoader';
import { decodeX86_64 } from '../capstone/capstoneDecoder';
import {
  blinkUnsupportedIsaFamily,
  type BlinkIsaAudit,
  type BlinkIsaEvidence,
  type BlinkUnsupportedIsaFamily
} from './blinkIsaPreflight';
import { REQUIRED_BLINK_BUILD_PROFILE } from './blinkBuildProfile';
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
  auditModule?: (module: MaterializedRuntimeModule) => Promise<BlinkIsaAudit>;
  auditInterpreterEntry?: (module: MaterializedRuntimeModule) => Promise<BlinkIsaEvidence | null>;
}

interface RuntimeExecutableSegment {
  index: number;
  offset: number;
  virtualAddress: number;
  fileSize: number;
}

interface RuntimeElfExecutionLayout {
  entry: number;
  segments: RuntimeExecutableSegment[];
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

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} exceeds the browser-safe integer range.`);
  return number;
}

/**
 * Runtime dependency preparation already parsed DT_NEEDED with a lightweight
 * program-header path. ISA inventory follows the same rule: do not call the
 * heavyweight LoadedImage parser (symbols/relocations/unwind/function discovery)
 * merely to locate executable PT_LOAD bytes in libc/ld.so.
 */
function runtimeElfExecutionLayout(bytes: ArrayBuffer): RuntimeElfExecutionLayout {
  const header = inspectElfHeader(bytes);
  if (!header.valid) throw new Error(header.reason ?? 'Runtime ISA module is not an ELF file.');
  if (header.elfClass !== 64 || !header.littleEndian || header.architecture !== 'x86-64') {
    throw new Error(`Runtime ISA module must be little-endian ELF64 x86-64; got ${header.architecture ?? 'unknown'}.`);
  }
  if (bytes.byteLength < 64) throw new Error('Runtime ISA module has a truncated ELF64 header.');

  const view = new DataView(bytes);
  const phoff = safeNumber(view.getBigUint64(32, true), 'program-header offset');
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  const entry = safeNumber(view.getBigUint64(24, true), 'ELF entry');
  if (phnum && phentsize < 56) throw new Error(`Unexpected ELF64 program-header size ${phentsize}.`);
  if (phoff + phentsize * phnum > bytes.byteLength) throw new Error('Runtime ISA program-header table exceeds ELF bytes.');

  const segments: RuntimeExecutableSegment[] = [];
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize;
    const type = view.getUint32(offset, true);
    const flags = view.getUint32(offset + 4, true);
    if (type !== 1 || (flags & 1) === 0) continue; // PT_LOAD + PF_X
    const fileOffset = safeNumber(view.getBigUint64(offset + 8, true), `PT_LOAD#${index} file offset`);
    const virtualAddress = safeNumber(view.getBigUint64(offset + 16, true), `PT_LOAD#${index} virtual address`);
    const fileSize = safeNumber(view.getBigUint64(offset + 32, true), `PT_LOAD#${index} file size`);
    if (fileOffset + fileSize > bytes.byteLength) throw new Error(`Executable PT_LOAD#${index} exceeds ELF bytes.`);
    if (fileSize > 0) segments.push({ index, offset: fileOffset, virtualAddress, fileSize });
  }
  segments.sort((left, right) => left.virtualAddress - right.virtualAddress);
  return { entry, segments };
}

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function auditRuntimeModuleBytes(module: MaterializedRuntimeModule, maxEvidence = 12): Promise<BlinkIsaAudit> {
  const layout = runtimeElfExecutionLayout(module.bytes);
  const capstone = await loadCapstone();
  const families = new Set<BlinkUnsupportedIsaFamily>();
  const evidence: BlinkIsaEvidence[] = [];
  const chunkSize = 96 * 1024;
  let scannedInstructions = 0;
  let decodedBytes = 0;
  let skippedBytes = 0;
  let chunks = 0;

  for (const segment of layout.segments) {
    let cursor = segment.virtualAddress;
    const end = segment.virtualAddress + segment.fileSize;
    while (cursor < end) {
      const relative = cursor - segment.virtualAddress;
      const requested = Math.min(chunkSize, end - cursor);
      const sourceOffset = segment.offset + relative;
      const bytes = new Uint8Array(module.bytes, sourceOffset, requested);
      const decoded = decodeX86_64(capstone, bytes, cursor, { maxInstructions: 32768 });
      if (!decoded.length) {
        cursor += 1;
        skippedBytes += 1;
      } else {
        for (const instruction of decoded) {
          if (instruction.address >= end) break;
          scannedInstructions += 1;
          const family = blinkUnsupportedIsaFamily({ bytes: instruction.bytes, mnemonic: instruction.mnemonic });
          if (!family) continue;
          families.add(family);
          if (evidence.length < maxEvidence) {
            evidence.push({
              family,
              address: instruction.address,
              mnemonic: instruction.mnemonic,
              operands: instruction.operands,
              bytes: instruction.bytes.slice(),
              sectionName: `PT_LOAD#${segment.index}`
            });
          }
        }
        const last = decoded.at(-1)!;
        const advanced = Math.max(1, Math.min(end, last.endAddress) - cursor);
        cursor += advanced;
        decodedBytes += advanced;
      }
      chunks += 1;
      if (chunks % 4 === 0) await nextFrame();
    }
  }

  return {
    compatible: families.size === 0,
    profile: REQUIRED_BLINK_BUILD_PROFILE,
    scannedInstructions,
    decodedBytes,
    skippedBytes,
    unsupportedFamilies: [...families],
    evidence
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
  const layout = runtimeElfExecutionLayout(module.bytes);
  if (!layout.entry) return null;
  const segment = layout.segments.find((candidate) =>
    layout.entry >= candidate.virtualAddress && layout.entry < candidate.virtualAddress + candidate.fileSize
  );
  if (!segment) return null;

  const relative = layout.entry - segment.virtualAddress;
  const available = Math.min(15, segment.fileSize - relative);
  if (available <= 0) return null;
  const bytes = new Uint8Array(module.bytes, segment.offset + relative, available);
  const capstone = await loadCapstone();
  const instruction = decodeX86_64(capstone, bytes, layout.entry, { maxInstructions: 1 })[0];
  if (!instruction || instruction.address !== layout.entry) return null;

  const family = blinkUnsupportedIsaFamily({ bytes: instruction.bytes, mnemonic: instruction.mnemonic });
  if (!family) return null;
  return {
    family,
    address: instruction.address,
    mnemonic: instruction.mnemonic,
    operands: instruction.operands,
    bytes: instruction.bytes.slice(),
    sectionName: `PT_LOAD#${segment.index} entry`
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

  const auditModule = dependencies.auditModule ?? auditRuntimeModuleBytes;
  const auditInterpreterEntry = dependencies.auditInterpreterEntry ?? auditBlinkInterpreterEntryIsa;
  const modules: BlinkRuntimeModuleIsaAudit[] = [];

  for (const module of closure.modules) {
    const role = moduleRole(module, closure.interpreterPath);
    const audit = await auditModule(module);
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
