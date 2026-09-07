import type { ElfSegment, LoadedImage } from '../binary/model';
import {
  blinkRuntimeByteWindow,
  blinkRuntimeInstructionLine,
  blinkRuntimeCursorLine
} from './runtimeDisassembly';

const PT_LOAD = 1;
const PF_X = 1;
const EM_X86_64 = 62;

export type RuntimeImageRole = 'program' | 'interpreter' | 'dependency';

export interface RuntimeImageCandidate {
  id: string;
  name: string;
  role: RuntimeImageRole;
  bytes: Uint8Array;
  segments: Array<Pick<ElfSegment, 'offset' | 'virtualAddress' | 'fileSize' | 'memorySize' | 'executable'>>;
}

export interface RuntimeImageMatch {
  candidateId: string;
  name: string;
  role: RuntimeImageRole;
  runtimeAddress: bigint;
  imageAddress: bigint;
  loadBias: bigint;
  confidence: 'fixed-address' | 'cached-signature' | 'signature';
  signatureBytes: number;
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} exceeds browser-safe ELF range.`);
  return number;
}

function exactBytes(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

export function runtimeImageCandidateFromLoadedImage(
  id: string,
  name: string,
  role: RuntimeImageRole,
  buffer: ArrayBuffer,
  image: LoadedImage
): RuntimeImageCandidate {
  return {
    id,
    name,
    role,
    bytes: exactBytes(buffer),
    segments: image.segments.map((segment) => ({
      offset: segment.offset,
      virtualAddress: segment.virtualAddress,
      fileSize: segment.fileSize,
      memorySize: segment.memorySize,
      executable: segment.executable
    }))
  };
}

/**
 * Parse only the ELF64 program-header information needed for runtime address
 * ownership. Dependency resolution must not pay full symbol/unwind analysis for
 * libc/ld.so just to identify the module containing the current RIP.
 */
export function runtimeImageCandidateFromElfBytes(
  id: string,
  name: string,
  role: RuntimeImageRole,
  buffer: ArrayBuffer
): RuntimeImageCandidate {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error(`Runtime image ${name} is not an ELF file.`);
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error(`Runtime image ${name} must be little-endian ELF64.`);
  const view = new DataView(buffer);
  if (view.getUint16(18, true) !== EM_X86_64) throw new Error(`Runtime image ${name} is not x86-64.`);

  const phoff = safeNumber(view.getBigUint64(32, true), `${name} program header offset`);
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  if (phnum && phentsize < 56) throw new Error(`Runtime image ${name} has invalid ELF64 program-header size ${phentsize}.`);
  if (phoff + phentsize * phnum > bytes.byteLength) throw new Error(`Runtime image ${name} program headers exceed file bytes.`);

  const segments: RuntimeImageCandidate['segments'] = [];
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize;
    const type = view.getUint32(offset, true);
    if (type !== PT_LOAD) continue;
    const flags = view.getUint32(offset + 4, true);
    const fileOffset = safeNumber(view.getBigUint64(offset + 8, true), `${name} segment offset`);
    const virtualAddress = safeNumber(view.getBigUint64(offset + 16, true), `${name} segment virtual address`);
    const fileSize = safeNumber(view.getBigUint64(offset + 32, true), `${name} segment file size`);
    const memorySize = safeNumber(view.getBigUint64(offset + 40, true), `${name} segment memory size`);
    if (fileOffset + fileSize > bytes.byteLength) throw new Error(`Runtime image ${name} PT_LOAD exceeds file bytes.`);
    segments.push({
      offset: fileOffset,
      virtualAddress,
      fileSize,
      memorySize,
      executable: (flags & PF_X) !== 0
    });
  }
  return { id, name, role, bytes, segments };
}

function bytesEqualAt(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset < 0 || offset + needle.length > haystack.length) return false;
  for (let index = 0; index < needle.length; index += 1) {
    if (haystack[offset + index] !== needle[index]) return false;
  }
  return true;
}

function findSequence(haystack: Uint8Array, start: number, end: number, needle: Uint8Array): number[] {
  const matches: number[] = [];
  if (!needle.length) return matches;
  const limit = Math.min(haystack.length, end) - needle.length;
  for (let offset = Math.max(0, start); offset <= limit; offset += 1) {
    if (haystack[offset] !== needle[0]) continue;
    if (bytesEqualAt(haystack, offset, needle)) matches.push(offset);
  }
  return matches;
}

function instructionAtRip(lines: string[], rip: bigint, fallback: number) {
  const line = blinkRuntimeCursorLine(lines, rip, fallback);
  return blinkRuntimeInstructionLine(lines[line] ?? '', line);
}

function matchWithBias(
  candidate: RuntimeImageCandidate,
  bias: bigint,
  rip: bigint,
  instructionBytes: Uint8Array
): boolean {
  const imageAddress = rip - bias;
  if (imageAddress < 0n) return false;
  for (const segment of candidate.segments) {
    if (!segment.executable) continue;
    const start = BigInt(segment.virtualAddress);
    const end = start + BigInt(segment.fileSize);
    if (imageAddress < start || imageAddress + BigInt(instructionBytes.length) > end) continue;
    const fileOffset = segment.offset + Number(imageAddress - start);
    if (bytesEqualAt(candidate.bytes, fileOffset, instructionBytes)) return true;
  }
  return false;
}

export class RuntimeImageResolver {
  private readonly knownBiases = new Map<string, bigint>();

  constructor(private readonly candidates: RuntimeImageCandidate[], fixedBiases: ReadonlyMap<string, bigint> = new Map()) {
    for (const [id, bias] of fixedBiases) this.knownBiases.set(id, bias);
  }

  knownLoadBias(candidateId: string): bigint | null {
    return this.knownBiases.get(candidateId) ?? null;
  }

  /**
   * Resolve an observed runtime address from bytes read directly from guest
   * memory. This is used by headless fatal-signal diagnostics where Blink's
   * internal disassembler intentionally remains disabled. A unique executable
   * byte signature proves image identity + load bias; ambiguous signatures fail
   * closed rather than assigning the crash to the wrong shared object.
   */
  resolveBytes(runtimeAddress: bigint, observedBytes: Uint8Array, minimumSignatureBytes = 6): RuntimeImageMatch | null {
    if (runtimeAddress < 0n || observedBytes.length < minimumSignatureBytes) return null;

    const cachedMatches: RuntimeImageMatch[] = [];
    for (const candidate of this.candidates) {
      const bias = this.knownBiases.get(candidate.id);
      if (bias === undefined || !matchWithBias(candidate, bias, runtimeAddress, observedBytes)) continue;
      cachedMatches.push({
        candidateId: candidate.id,
        name: candidate.name,
        role: candidate.role,
        runtimeAddress,
        imageAddress: runtimeAddress - bias,
        loadBias: bias,
        confidence: bias === 0n && candidate.role === 'program' ? 'fixed-address' : 'cached-signature',
        signatureBytes: observedBytes.length
      });
    }
    if (cachedMatches.length === 1) return cachedMatches[0];
    if (cachedMatches.length > 1) return null;

    const matches: RuntimeImageMatch[] = [];
    const identities = new Set<string>();
    for (const candidate of this.candidates) {
      for (const segment of candidate.segments) {
        if (!segment.executable || segment.fileSize < observedBytes.length) continue;
        const start = segment.offset;
        const end = segment.offset + segment.fileSize;
        for (const fileOffset of findSequence(candidate.bytes, start, end, observedBytes)) {
          const imageAddress = BigInt(segment.virtualAddress + (fileOffset - segment.offset));
          const bias = runtimeAddress - imageAddress;
          const identity = `${candidate.id}:${bias.toString(16)}`;
          if (identities.has(identity)) continue;
          identities.add(identity);
          matches.push({
            candidateId: candidate.id,
            name: candidate.name,
            role: candidate.role,
            runtimeAddress,
            imageAddress,
            loadBias: bias,
            confidence: bias === 0n && candidate.role === 'program' ? 'fixed-address' : 'signature',
            signatureBytes: observedBytes.length
          });
        }
      }
    }

    if (matches.length !== 1) return null;
    const match = matches[0];
    this.knownBiases.set(match.candidateId, match.loadBias);
    return match;
  }

  resolve(lines: string[], rip: bigint, fallbackLine: number): RuntimeImageMatch | null {
    const instruction = instructionAtRip(lines, rip, fallbackLine);
    if (!instruction?.bytes.length) return null;

    // Once a module's bias has been proven by bytes, subsequent steps resolve in
    // O(segments) rather than rescanning large libc/loader files.
    const cachedMatches: RuntimeImageMatch[] = [];
    for (const candidate of this.candidates) {
      const bias = this.knownBiases.get(candidate.id);
      if (bias === undefined || !matchWithBias(candidate, bias, rip, instruction.bytes)) continue;
      cachedMatches.push({
        candidateId: candidate.id,
        name: candidate.name,
        role: candidate.role,
        runtimeAddress: rip,
        imageAddress: rip - bias,
        loadBias: bias,
        confidence: bias === 0n && candidate.role === 'program' ? 'fixed-address' : 'cached-signature',
        signatureBytes: instruction.bytes.length
      });
    }
    if (cachedMatches.length === 1) return cachedMatches[0];
    if (cachedMatches.length > 1) return null;

    const window = blinkRuntimeByteWindow(lines, rip, fallbackLine, 32);
    if (!window || window.bytes.length < 6) return null;

    const matches: RuntimeImageMatch[] = [];
    const identities = new Set<string>();
    for (const candidate of this.candidates) {
      for (const segment of candidate.segments) {
        if (!segment.executable || segment.fileSize < window.bytes.length) continue;
        const segmentStart = segment.offset;
        const segmentEnd = segment.offset + segment.fileSize;
        for (const fileOffset of findSequence(candidate.bytes, segmentStart, segmentEnd, window.bytes)) {
          const imageWindowAddress = BigInt(segment.virtualAddress + (fileOffset - segment.offset));
          const bias = window.address - imageWindowAddress;
          const imageAddress = rip - bias;
          if (imageAddress < 0n) continue;
          const identity = `${candidate.id}:${bias.toString(16)}`;
          if (identities.has(identity)) continue;
          identities.add(identity);
          matches.push({
            candidateId: candidate.id,
            name: candidate.name,
            role: candidate.role,
            runtimeAddress: rip,
            imageAddress,
            loadBias: bias,
            confidence: bias === 0n && candidate.role === 'program' ? 'fixed-address' : 'signature',
            signatureBytes: window.bytes.length
          });
        }
      }
    }

    // Fail closed on ambiguous x86 byte signatures. A wrong module name/load
    // bias is more damaging to debugger navigation than an explicit unknown.
    if (matches.length !== 1) return null;
    const match = matches[0];
    this.knownBiases.set(match.candidateId, match.loadBias);
    return match;
  }
}
