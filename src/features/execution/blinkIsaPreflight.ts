import { loadFullBinaryDisassembly, type BinaryDisassemblyDocument, type BinaryDisassemblyLine } from '../analysis/binaryDisassembly';
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

export function auditBlinkIsaDocument(document: BinaryDisassemblyDocument, maxEvidence = 12): BlinkIsaAudit {
  const families = new Set<BlinkUnsupportedIsaFamily>();
  const evidence: BlinkIsaEvidence[] = [];

  for (const line of document.lines) {
    const family = blinkUnsupportedIsaFamily(line);
    if (!family) continue;
    families.add(family);
    if (evidence.length < maxEvidence) {
      evidence.push({
        family,
        address: line.address,
        mnemonic: line.mnemonic,
        operands: line.operands,
        bytes: line.bytes.slice(),
        sectionName: line.sectionName
      });
    }
  }

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

export async function auditBlinkIsaForFile(file: ProjectFile): Promise<BlinkIsaAudit> {
  if (file.kind !== 'binary' || !file.bytes) throw new Error('Blink ISA preflight requires authoritative binary bytes.');
  return auditBlinkIsaDocument(await loadFullBinaryDisassembly(file));
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
    ? ` First decoded unsupported instruction: 0x${first.address.toString(16)} ${first.mnemonic}${first.operands ? ` ${first.operands}` : ''} [${bytesLabel(first.bytes)}] in ${first.sectionName}.`
    : '';
  const skipped = audit.skippedBytes > 0
    ? ` Capstone skipped ${audit.skippedBytes.toLocaleString()} executable byte(s); the rejection is based only on positively decoded unsupported instructions.`
    : '';

  return `${fileName} is incompatible with Blink profile ${audit.profile}. Executable bytes require ${families}.${firstInstruction}${skipped} ELF ISA notes are advisory here; execution compatibility is decided from authoritative executable bytes decoded by Capstone. Rebuild the guest for portable x86-64 baseline (for Zig/VZed, use an explicit baseline CPU target rather than native CPU features).`;
}
