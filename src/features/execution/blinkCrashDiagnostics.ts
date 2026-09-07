import type { ElfSymbol, LoadedImage } from '../binary/model';
import { decodeX86_64 } from '../capstone/capstoneDecoder';
import { currentCapstone } from '../capstone/capstoneLoader';
import type { ProjectFile } from '../project/model';
import { blinkUnsupportedIsaFamily } from './blinkIsaPreflight';
import type { ExecutionCrashSnapshot, ExecutionRegisterSnapshot } from './model';
import type { RuntimeImageMatch } from './runtimeImageResolver';

const X86_MAX_INSTRUCTION_BYTES = 15;

const SIGNAL_NAMES = new Map<number, string>([
  [1, 'SIGHUP'],
  [2, 'SIGINT'],
  [3, 'SIGQUIT'],
  [4, 'SIGILL'],
  [5, 'SIGTRAP'],
  [6, 'SIGABRT'],
  [7, 'SIGBUS'],
  [8, 'SIGFPE'],
  [9, 'SIGKILL'],
  [11, 'SIGSEGV'],
  [13, 'SIGPIPE'],
  [14, 'SIGALRM'],
  [15, 'SIGTERM'],
  [24, 'SIGXCPU']
]);

function signalName(signal: number): string {
  return SIGNAL_NAMES.get(signal) ?? `SIG${signal}`;
}

function safeAddress(value: bigint): number | null {
  const address = Number(value);
  return Number.isSafeInteger(address) && address >= 0 ? address : null;
}

function containingFunction(image: LoadedImage, address: number): ElfSymbol | null {
  const functions = image.functions
    .filter((symbol) => symbol.defined && symbol.functionLike && symbol.value <= address)
    .sort((left, right) => right.value - left.value);
  for (const symbol of functions) {
    if (symbol.size > 0 && address >= symbol.value + symbol.size) continue;
    return symbol;
  }
  return functions[0] ?? null;
}

function fixedProgramBytes(file: ProjectFile, image: LoadedImage, runtimeAddress: bigint): {
  imageAddress: number;
  codeBytes: number[];
  functionName: string | null;
  functionOffset: number | null;
} | null {
  if (image.kind !== 'executable' || file.kind !== 'binary' || !file.bytes) return null;
  const address = safeAddress(runtimeAddress);
  if (address === null) return null;
  const segment = image.segments.find((candidate) => candidate.executable
    && address >= candidate.virtualAddress
    && address < candidate.virtualAddress + candidate.fileSize);
  if (!segment) return null;

  const relative = address - segment.virtualAddress;
  const fileOffset = segment.offset + relative;
  const available = Math.max(0, Math.min(X86_MAX_INSTRUCTION_BYTES, segment.fileSize - relative));
  const codeBytes = [...new Uint8Array(file.bytes, fileOffset, available)];
  const symbol = containingFunction(image, address);
  return {
    imageAddress: address,
    codeBytes,
    functionName: symbol?.name || null,
    functionOffset: symbol ? address - symbol.value : null
  };
}

export interface BlinkFatalSignalEvidence {
  /** Bytes observed directly from Blink guest memory at architectural RIP. */
  runtimeCodeBytes?: readonly number[];
  /** Unique image/load-bias match proven from those observed bytes. */
  runtimeImage?: RuntimeImageMatch | null;
}

export function captureBlinkFatalSignal(
  file: ProjectFile,
  image: LoadedImage,
  signal: number,
  signalCode: number,
  registers: ExecutionRegisterSnapshot | null,
  evidence: BlinkFatalSignalEvidence = {}
): ExecutionCrashSnapshot {
  const runtimeAddress = registers?.rip ?? null;
  const observedBytes = evidence.runtimeCodeBytes?.slice(0, X86_MAX_INSTRUCTION_BYTES) ?? [];
  const matchedImage = evidence.runtimeImage ?? null;
  const fixed = runtimeAddress === null ? null : fixedProgramBytes(file, image, runtimeAddress);

  const imageAddressBig = matchedImage?.imageAddress
    ?? (fixed ? BigInt(fixed.imageAddress) : null);
  const decodeAddress = imageAddressBig !== null
    ? safeAddress(imageAddressBig)
    : runtimeAddress !== null ? safeAddress(runtimeAddress) : null;
  const codeBytes = observedBytes.length ? [...observedBytes] : fixed?.codeBytes ?? [];

  let functionName: string | null = null;
  let functionOffset: number | null = null;
  if (matchedImage?.role === 'program' && imageAddressBig !== null) {
    const canonicalAddress = safeAddress(imageAddressBig);
    if (canonicalAddress !== null) {
      const symbol = containingFunction(image, canonicalAddress);
      functionName = symbol?.name || null;
      functionOffset = symbol ? canonicalAddress - symbol.value : null;
    }
  } else if (!matchedImage && fixed) {
    functionName = fixed.functionName;
    functionOffset = fixed.functionOffset;
  }

  let instruction: ExecutionCrashSnapshot['instruction'] = null;
  let isaFamily: string | null = null;
  if (decodeAddress !== null && codeBytes.length) {
    const capstone = currentCapstone();
    if (capstone) {
      try {
        const decoded = decodeX86_64(capstone, Uint8Array.from(codeBytes), decodeAddress, { maxInstructions: 1 })[0] ?? null;
        if (decoded && decoded.address === decodeAddress) {
          instruction = {
            address: decoded.address,
            endAddress: decoded.endAddress,
            bytes: decoded.bytes.slice(),
            mnemonic: decoded.mnemonic,
            operands: decoded.operands
          };
          isaFamily = blinkUnsupportedIsaFamily(decoded);
        }
      } catch {
        // Signal/register/observed-byte evidence remains authoritative even if
        // secondary Capstone decoding fails. Do not replace an observed RIP or
        // uniquely proven runtime image with a guessed instruction.
      }
    }
  }

  return {
    signal,
    signalName: signalName(signal),
    signalCode,
    exitCode: 128 + signal,
    runtimeAddress,
    imageName: matchedImage?.name ?? (fixed ? file.name : null),
    imageRole: matchedImage?.role ?? (fixed ? 'program' : null),
    imageAddress: imageAddressBig,
    loadBias: matchedImage?.loadBias ?? (fixed ? 0n : null),
    functionName,
    functionOffset,
    codeBytes,
    instruction,
    isaFamily,
    evidence: 'blink-headless-signal-clstruct'
  };
}

function bytesLabel(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

export function describeBlinkFatalSignal(crash: ExecutionCrashSnapshot): string {
  const at = crash.runtimeAddress !== null ? ` at RIP 0x${crash.runtimeAddress.toString(16)}` : '';
  const image = crash.imageName && crash.imageAddress !== null
    ? ` in ${crash.imageName} @ ELF 0x${crash.imageAddress.toString(16)}`
    : '';
  const fn = crash.functionName
    ? ` (${crash.functionName}${crash.functionOffset ? `+0x${crash.functionOffset.toString(16)}` : ''})`
    : '';
  const instruction = crash.instruction
    ? ` Instruction: ${crash.instruction.mnemonic}${crash.instruction.operands ? ` ${crash.instruction.operands}` : ''} [${bytesLabel(crash.instruction.bytes)}].`
    : crash.codeBytes.length
      ? ` Observed code bytes at RIP: [${bytesLabel(crash.codeBytes)}].`
      : '';
  const isa = crash.isaFamily ? ` Decoded ISA family: ${crash.isaFamily}.` : '';
  return `Blink guest terminated by ${crash.signalName} (signal ${crash.signal}, code ${crash.signalCode}, exit ${crash.exitCode})${at}${image}${fn}.${instruction}${isa}`;
}
