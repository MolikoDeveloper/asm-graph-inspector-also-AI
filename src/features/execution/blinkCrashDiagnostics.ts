import type { ElfSymbol, LoadedImage } from '../binary/model';
import { decodeX86_64 } from '../capstone/capstoneDecoder';
import { currentCapstone } from '../capstone/capstoneLoader';
import type { ProjectFile } from '../project/model';
import { blinkUnsupportedIsaFamily } from './blinkIsaPreflight';
import type { ExecutionCrashSnapshot, ExecutionRegisterSnapshot } from './model';

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

export function captureBlinkFatalSignal(
  file: ProjectFile,
  image: LoadedImage,
  signal: number,
  signalCode: number,
  registers: ExecutionRegisterSnapshot | null
): ExecutionCrashSnapshot {
  const runtimeAddress = registers?.rip ?? null;
  const fixed = runtimeAddress === null ? null : fixedProgramBytes(file, image, runtimeAddress);
  let instruction: ExecutionCrashSnapshot['instruction'] = null;
  let isaFamily: string | null = null;

  if (fixed && fixed.codeBytes.length) {
    const capstone = currentCapstone();
    if (capstone) {
      try {
        const decoded = decodeX86_64(capstone, Uint8Array.from(fixed.codeBytes), fixed.imageAddress, { maxInstructions: 1 })[0] ?? null;
        if (decoded && decoded.address === fixed.imageAddress) {
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
        // Signal/register evidence remains authoritative even if secondary
        // Capstone decoding fails. Do not replace an observed RIP with a guess.
      }
    }
  }

  return {
    signal,
    signalName: signalName(signal),
    signalCode,
    exitCode: 128 + signal,
    runtimeAddress,
    imageName: fixed ? file.name : null,
    imageRole: fixed ? 'program' : null,
    imageAddress: fixed ? BigInt(fixed.imageAddress) : null,
    loadBias: fixed ? 0n : null,
    functionName: fixed?.functionName ?? null,
    functionOffset: fixed?.functionOffset ?? null,
    codeBytes: fixed?.codeBytes ?? [],
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
      ? ` Code bytes at RIP: [${bytesLabel(crash.codeBytes)}].`
      : '';
  const isa = crash.isaFamily ? ` Decoded ISA family: ${crash.isaFamily}.` : '';
  return `Blink guest terminated by ${crash.signalName} (signal ${crash.signal}, code ${crash.signalCode}, exit ${crash.exitCode})${at}${image}${fn}.${instruction}${isa}`;
}
