import {
  auditBlinkIsaDocument,
  blinkUnsupportedIsaFamily,
  describeBlinkIsaAuditFailure
} from '../../src/features/execution/blinkIsaPreflight';
import type { BinaryDisassemblyDocument, BinaryDisassemblyLine } from '../../src/features/analysis/binaryDisassembly';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function line(address: number, mnemonic: string, bytes: number[], operands = ''): BinaryDisassemblyLine {
  return {
    address,
    endAddress: address + bytes.length,
    bytes,
    mnemonic,
    operands,
    sectionName: '.text',
    symbolName: null
  };
}

const baseline = line(0x401000, 'xor', [0x31, 0xc0], 'eax, eax');
const legacyV = line(0x401002, 'verr', [0x0f, 0x00, 0xe0], 'ax');
const avx = line(0x49c038, 'vbroadcastss', [0xc4, 0xe2, 0x7d, 0x18, 0x05, 0, 0, 0, 0], 'ymm0, dword ptr [rip]');
const gfni = line(0x49d000, 'vgf2p8affineqb', [0xc4, 0xe3, 0x7d, 0xce, 0xc0, 0], 'ymm0, ymm0, ymm0, 0');
const evex = line(0x49e000, 'kmovw', [0x62, 0xf1, 0x7d, 0x08, 0x90, 0xc0], 'k0, eax');
const vmx = line(0x49f000, 'vmcall', [0x0f, 0x01, 0xc1]);

assert(blinkUnsupportedIsaFamily(baseline) === null, 'baseline scalar instruction should pass');
assert(blinkUnsupportedIsaFamily(legacyV) === null, 'legacy VERR must not be mistaken for AVX');
assert(blinkUnsupportedIsaFamily(avx) === 'avx-family', 'VEX vector instruction should be classified as AVX family');
assert(blinkUnsupportedIsaFamily(gfni) === 'gfni', 'GFNI instruction should be classified before generic AVX');
assert(blinkUnsupportedIsaFamily(evex) === 'avx512-family', 'EVEX lead byte should be rejected as AVX-512 family');
assert(blinkUnsupportedIsaFamily(vmx) === 'vmx', 'VMX instruction should be reported separately');

const document: BinaryDisassemblyDocument = {
  fileId: 'fixture',
  signature: 'fixture:1',
  lines: [baseline, legacyV, avx, gfni, evex, vmx],
  sectionCount: 1,
  decodedBytes: 31,
  skippedBytes: 0
};

const audit = auditBlinkIsaDocument(document);
assert(!audit.compatible, 'document with AVX/GFNI/EVEX/VMX should be incompatible');
assert(audit.scannedInstructions === 6, 'audit should report all scanned instructions');
assert(audit.unsupportedFamilies.includes('avx-family'), 'audit should include AVX family');
assert(audit.unsupportedFamilies.includes('gfni'), 'audit should include GFNI');
assert(audit.unsupportedFamilies.includes('avx512-family'), 'audit should include AVX-512/EVEX');
assert(audit.unsupportedFamilies.includes('vmx'), 'audit should include VMX');
assert(audit.evidence[0]?.address === 0x49c038, 'first unsupported evidence should be the first decoded unsupported address');

const message = describeBlinkIsaAuditFailure('ray_test', audit);
assert(message.includes('0x49c038 vbroadcastss'), 'diagnostic should expose the first unsupported instruction');
assert(message.includes('x86-64-baseline'), 'diagnostic should name the pinned Blink baseline profile');
assert(message.includes('authoritative executable PT_LOAD bytes decoded by Capstone'), 'diagnostic should explain the evidence source');
assert(message.includes('baseline CPU target'), 'diagnostic should recommend portable guest generation');

const compatible = auditBlinkIsaDocument({ ...document, lines: [baseline, legacyV] });
assert(compatible.compatible, 'baseline-only document should pass the Blink ISA preflight');
assert(compatible.unsupportedFamilies.length === 0, 'baseline-only document should have no unsupported families');

console.log('Blink ISA preflight smoke: PASS');
