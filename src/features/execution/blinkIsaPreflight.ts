import type { BinaryDisassemblyDocument, BinaryDisassemblyLine } from '../analysis/binaryDisassembly';
import { executableBytesForRange, parseElfImage } from '../binary/elfParser';
import { loadCapstone } from '../capstone/capstoneLoader';
import { decodeX86_64 } from '../capstone/capstoneDecoder';
import type { ProjectFile } from '../project/model';
import { REQUIRED_BLINK_BUILD_PROFILE } from './blinkBuildProfile';

export type BlinkUnsupportedIsaFamily = 'avx-family' | 'avx512-family' | 'gfni' | 'vmx';

export interface BlinkIsaEvidence {
  family: BlinkUnsupportedIsaFamily;
  address: number;
  mnemonic: string;
  operands: string;
  bytes: number[];
  sectionName: string;
}

export interface BlinkIsaAudit {
  compatible: boolean;
  profile: typeof REQUIRED_BLINK_BUILD_PROFILE;
  scannedInstructions: number;
  decodedBytes: number;
  skippedBytes: number;
  unsupportedFamilies: BlinkUnsupportedIsaFamily[];
  evidence: BlinkIsaEvidence[];
}

export interface BlinkIsaAuditProgress {
  scannedInstructions: number;
  processedBytes: number;
  totalBytes: number;
  decodedBytes: number;
  skippedBytes: number;
  unsupportedFamilies: BlinkUnsupportedIsaFamily[];
  evidence: BlinkIsaEvidence[];
}

export type BlinkIsaPreflightStatus = 'idle' | 'scanning' | 'compatible' | 'incompatible' | 'error';

export interface BlinkIsaPreflightState {
  status: BlinkIsaPreflightStatus;
  targetFileId: string | null;
  targetName: string | null;
  elapsedMs: number | null;
  scannedInstructions: number;
  processedBytes: number;
  totalBytes: number;
  unsupportedFamilies: BlinkUnsupportedIsaFamily[];
  evidence: BlinkIsaEvidence[];
  message: string | null;
}

export function idleBlinkIsaPreflight(): BlinkIsaPreflightState {
  return {
    status: 'idle',
    targetFileId: null,
    targetName: null,
    elapsedMs: null,
    scannedInstructions: 0,
    processedBytes: 0,
    totalBytes: 0,
    unsupportedFamilies: [],
    evidence: [],
    message: null
  };
}

const LEGACY_V_MNEMONICS = new Set(['verr', 'verw']);
const VMX_MNEMONICS = new Set([
  'vmcall',
  'vmclear',
  'vmfunc',
  'vmlaunch',
  'vmptrld',
  'vmptrst',
  'vmread',
  'vmresume',
  'vmwrite',
  'vmxoff',
  'vmxon'
]);

export function blinkUnsupportedIsaFamily(line: Pick<BinaryDisassemblyLine, 'bytes' | 'mnemonic'>): BlinkUnsupportedIsaFamily | null {
  const mnemonic = line.mnemonic.trim().toLowerCase();
  if (!mnemonic) return null;

  // 0x62 is the EVEX lead byte in 64-bit mode. The pinned browser Blink
  // profile intentionally targets x86-64-baseline and does not implement the
  // AVX-512/EVEX execution model.
  if (line.bytes[0] === 0x62) return 'avx512-family';

  // GFNI instructions are outside the pinned Blink CPU contract. Keep this
  // classification ahead of the generic VEX/AVX bucket so diagnostics name
  // the stronger requirement when possible.
  if (mnemonic.startsWith('vgf2p8')) return 'gfni';

  // VMX instructions also start with "vm..." but are not AVX. They are not
  // part of the browser sandbox contract either, so report them separately.
  if (VMX_MNEMONICS.has(mnemonic)) return 'vmx';

  // VERR/VERW are legacy protected-mode instructions whose names happen to
  // start with v. Do not mistake them for VEX vector instructions.
  if (LEGACY_V_MNEMONICS.has(mnemonic)) return null;

  // AVX, AVX2, FMA, F16C, VAES, VPCLMUL and related VEX vector forms use a
  // mnemonic beginning with v. BMI/BMI2 VEX encodings such as pdep/pext/mulx
  // deliberately do not, which matters because Blink can implement selected
  // VEX-encoded scalar instructions without implementing AVX/AVX2 as a whole.
  if (mnemonic.startsWith('v')) return 'avx-family';

  return null;
}

function addEvidence(
  families: Set<BlinkUnsupportedIsaFamily>,
  evidence: BlinkIsaEvidence[],
  line: Pick<BinaryDisassemblyLine, 'address' | 'bytes' | 'mnemonic' | 'operands' | 'sectionName'>,
  maxEvidence: number
): void {
  const family = blinkUnsupportedIsaFamily(line);
  if (!family) return;
  families.add(family);
  if (evidence.length >= maxEvidence) return;
  evidence.push({
    family,
    address: line.address,
    mnemonic: line.mnemonic,
    operands: line.operands,
    bytes: line.bytes.slice(),
    sectionName: line.sectionName
  });
}

export function auditBlinkIsaDocument(document: BinaryDisassemblyDocument, maxEvidence = 12): BlinkIsaAudit {
  const families = new Set<BlinkUnsupportedIsaFamily>();
  const evidence: BlinkIsaEvidence[] = [];

  for (const line of document.lines) addEvidence(families, evidence, line, maxEvidence);

  return {
    compatible: families.size === 0,
    profile: REQUIRED_BLINK_BUILD_PROFILE,
    scannedInstructions: document.lines.length,
    decodedBytes: document.decodedBytes,
    skippedBytes: document.skippedBytes,
    unsupportedFamilies: [...families],
    evidence
  };
}

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Audit the exact file-backed executable PT_LOAD bytes that Blink may execute.
 * This intentionally does not trust section headers or GNU ISA notes: stripped
 * binaries and stale metadata must not bypass the compatibility gate.
 */
export async function auditBlinkIsaForFile(
  file: ProjectFile,
  options: { maxEvidence?: number; onProgress?: (progress: BlinkIsaAuditProgress) => void } = {}
): Promise<BlinkIsaAudit> {
  if (file.kind !== 'binary' || !file.bytes) throw new Error('Blink ISA preflight requires authoritative binary bytes.');

  const maxEvidence = options.maxEvidence ?? 12;
  const image = parseElfImage(file.id, file.path, file.bytes);
  const capstone = await loadCapstone();
  const families = new Set<BlinkUnsupportedIsaFamily>();
  const evidence: BlinkIsaEvidence[] = [];
  const segments = image.segments.filter((segment) => segment.executable && segment.fileSize > 0).sort((left, right) => left.virtualAddress - right.virtualAddress);
  const totalBytes = segments.reduce((sum, segment) => sum + segment.fileSize, 0);
  const chunkSize = 96 * 1024;
  let scannedInstructions = 0;
  let processedBytes = 0;
  let decodedBytes = 0;
  let skippedBytes = 0;
  let chunks = 0;

  const report = () => options.onProgress?.({
    scannedInstructions,
    processedBytes,
    totalBytes,
    decodedBytes,
    skippedBytes,
    unsupportedFamilies: [...families],
    evidence: evidence.slice()
  });

  report();
  for (const segment of segments) {
    let cursor = segment.virtualAddress;
    const end = segment.virtualAddress + segment.fileSize;
    const segmentLabel = `PT_LOAD#${segment.index}`;

    while (cursor < end) {
      const before = cursor;
      const requested = Math.min(chunkSize, end - cursor);
      const bytes = executableBytesForRange(image, file.bytes, cursor, requested);
      const decoded = decodeX86_64(capstone, bytes, cursor, { maxInstructions: 32768 });

      if (!decoded.length) {
        cursor += 1;
        skippedBytes += 1;
      } else {
        for (const instruction of decoded) {
          if (instruction.address >= end) break;
          scannedInstructions += 1;
          addEvidence(families, evidence, {
            address: instruction.address,
            bytes: instruction.bytes,
            mnemonic: instruction.mnemonic,
            operands: instruction.operands,
            sectionName: segmentLabel
          }, maxEvidence);
        }
        const last = decoded.at(-1)!;
        const advanced = Math.max(1, Math.min(end, last.endAddress) - cursor);
        cursor += advanced;
        decodedBytes += advanced;
      }

      processedBytes += Math.max(0, cursor - before);
      report();
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

function familyLabel(family: BlinkUnsupportedIsaFamily): string {
  switch (family) {
    case 'avx-family': return 'AVX/VEX vector ISA (includes AVX2/FMA-style forms)';
    case 'avx512-family': return 'AVX-512/EVEX ISA';
    case 'gfni': return 'GFNI';
    case 'vmx': return 'VMX virtualization ISA';
  }
}

function bytesLabel(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

export function describeBlinkIsaAuditFailure(fileName: string, audit: BlinkIsaAudit): string {
  const first = audit.evidence[0];
  const families = audit.unsupportedFamilies.map(familyLabel).join(', ');
  const firstInstruction = first
    ? ` First static unsupported instruction found in executable bytes (not observed execution): 0x${first.address.toString(16)} ${first.mnemonic}${first.operands ? ` ${first.operands}` : ''} [${bytesLabel(first.bytes)}] in ${first.sectionName}.`
    : '';
  const skipped = audit.skippedBytes > 0
    ? ` Capstone skipped ${audit.skippedBytes.toLocaleString()} executable byte(s); the rejection is based only on positively decoded unsupported instructions.`
    : '';

  return `${fileName} is incompatible with Blink profile ${audit.profile}. Executable bytes require ${families}.${firstInstruction}${skipped} ELF ISA notes are advisory here; execution compatibility is decided from authoritative executable PT_LOAD bytes decoded by Capstone. Rebuild the guest for portable x86-64 baseline (for Zig/VZed, use an explicit baseline CPU target rather than native CPU features).`;
}
