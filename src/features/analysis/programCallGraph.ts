import type { CapstoneModule } from '../capstone/types';
import { decodeFunctionCandidate } from '../binary/functionDiscovery';
import type {
  BinaryFunctionCandidate,
  BinaryProgramTransfer,
  CanonicalInstruction,
  ElfPltStub,
  LoadedImage
} from '../binary/model';

export interface BinaryProgramCallGraph {
  transfers: BinaryProgramTransfer[];
  decodedFunctionCount: number;
  decodedInstructionCount: number;
  truncated: boolean;
  diagnostics: string[];
}

function candidateContaining(functions: BinaryFunctionCandidate[], address: number): BinaryFunctionCandidate | null {
  const exact = functions.find((candidate) => candidate.address === address);
  if (exact) return exact;
  return functions
    .filter((candidate) => candidate.endAddress !== null && address >= candidate.address && address < candidate.endAddress)
    .sort((left, right) => (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER))[0] ?? null;
}

function unconditionalJump(instruction: CanonicalInstruction): boolean {
  return instruction.controlFlow === 'jump' && /^(?:jmp|jmpq|ljmp)$/i.test(instruction.mnemonic);
}

function canonicalImmediate(instruction: CanonicalInstruction, registerName: string): number | null {
  if (instruction.mnemonic.toLowerCase() !== 'mov') return null;
  const [destination, source] = instruction.operandDetails;
  if (destination?.kind !== 'register' || source?.kind !== 'immediate') return null;
  if (destination.register !== registerName) return null;
  const value = typeof source.value === 'number' ? source.value : Number(source.value);
  return Number.isSafeInteger(value) ? value : null;
}

function ripRelativeRelocationSymbol(image: LoadedImage, instruction: CanonicalInstruction): string | null {
  const memory = instruction.memoryOperands.find((operand) => operand.base === 'rip');
  if (!memory || typeof memory.displacement !== 'number') return null;
  const slot = instruction.endAddress + memory.displacement;
  return image.relocations.find((relocation) => relocation.offset === slot)?.symbolName || null;
}

function inferLibcStartupMain(
  image: LoadedImage,
  functions: BinaryFunctionCandidate[],
  source: BinaryFunctionCandidate,
  instructions: CanonicalInstruction[]
): BinaryProgramTransfer | null {
  if (source.name !== '_start' && source.address !== image.entry) return null;
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (instruction.controlFlow !== 'call' || instruction.directTarget !== null) continue;
    const symbol = ripRelativeRelocationSymbol(image, instruction);
    if (!symbol?.startsWith('__libc_start_main')) continue;
    for (let cursor = index - 1; cursor >= Math.max(0, index - 12); cursor -= 1) {
      const candidateAddress = canonicalImmediate(instructions[cursor], 'rdi');
      if (candidateAddress === null) continue;
      const target = candidateContaining(functions, candidateAddress);
      if (!target || target.address !== candidateAddress) continue;
      return {
        fromAddress: source.address,
        toAddress: target.address,
        kind: 'startup',
        callsiteAddress: instruction.address,
        evidence: `${source.name} passes 0x${target.address.toString(16)} (${target.name}) in RDI to ${symbol}; modeled as the ELF libc startup handoff to main.`
      };
    }
  }
  return null;
}

/**
 * Builds an interprocedural graph without requiring users to open every function.
 * Only proven direct CALL / terminal JMP targets are connected. A narrow, evidence-
 * backed __libc_start_main pattern is recognized so normal dynamically linked ELF
 * startup can connect _start to main without pretending the loader is a direct call.
 */
export function discoverProgramCallGraph(
  image: LoadedImage,
  buffer: ArrayBuffer,
  module: CapstoneModule,
  functions: BinaryFunctionCandidate[],
  pltStubs: ElfPltStub[],
  options: { maxFunctions?: number; maxInstructions?: number } = {}
): BinaryProgramCallGraph {
  const maxFunctions = options.maxFunctions ?? 4096;
  const maxInstructions = options.maxInstructions ?? 500_000;
  const sorted = [...functions].sort((a, b) => a.address - b.address).slice(0, maxFunctions);
  const functionByAddress = new Map(sorted.map((candidate) => [candidate.address, candidate]));
  const pltByAddress = new Map(pltStubs.map((stub) => [stub.address, stub]));
  const transfers: BinaryProgramTransfer[] = [];
  const diagnostics: string[] = [];
  let decodedFunctionCount = 0;
  let decodedInstructionCount = 0;
  let truncated = functions.length > maxFunctions;

  const addTransfer = (transfer: BinaryProgramTransfer) => {
    if (transfer.fromAddress === transfer.toAddress && transfer.kind !== 'call') return;
    transfers.push(transfer);
  };

  for (const source of sorted) {
    if (decodedInstructionCount >= maxInstructions) {
      truncated = true;
      break;
    }
    let instructions: CanonicalInstruction[];
    try {
      const remaining = Math.max(1, maxInstructions - decodedInstructionCount);
      instructions = decodeFunctionCandidate(image, buffer, module, source, Math.min(16_384, remaining));
    } catch (error) {
      diagnostics.push(`Program call graph could not decode ${source.name} @ 0x${source.address.toString(16)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    decodedFunctionCount += 1;
    decodedInstructionCount += instructions.length;

    for (const instruction of instructions) {
      if (instruction.directTarget === null) continue;
      if (instruction.controlFlow === 'call') {
        const plt = pltByAddress.get(instruction.directTarget);
        const target = plt ? null : (functionByAddress.get(instruction.directTarget) ?? candidateContaining(sorted, instruction.directTarget));
        const targetAddress = plt?.address ?? target?.address ?? null;
        if (targetAddress === null) continue;
        addTransfer({
          fromAddress: source.address,
          toAddress: targetAddress,
          kind: 'call',
          callsiteAddress: instruction.address,
          evidence: plt
            ? `Direct CALL at 0x${instruction.address.toString(16)} reaches ${plt.name}.`
            : `Direct CALL at 0x${instruction.address.toString(16)} reaches ${target!.name}.`
        });
        continue;
      }
      if (unconditionalJump(instruction)) {
        const target = functionByAddress.get(instruction.directTarget) ?? candidateContaining(sorted, instruction.directTarget);
        if (target && target.address !== source.address) {
          addTransfer({
            fromAddress: source.address,
            toAddress: target.address,
            kind: 'tail-call',
            callsiteAddress: instruction.address,
            evidence: `Terminal/direct JMP at 0x${instruction.address.toString(16)} reaches ${target.name}; represented as an interprocedural tail transfer.`
          });
          // Unknown-size symbol candidates can decode linearly into the next function.
          // A proven interprocedural JMP is terminal for this source function.
          break;
        }
      }
      if (instruction.controlFlow === 'return' || /^(?:ret|retf|iret|iretq|hlt|ud2)$/i.test(instruction.mnemonic)) break;
    }

    const startup = inferLibcStartupMain(image, sorted, source, instructions);
    if (startup) addTransfer(startup);
  }

  const unique = new Map<string, BinaryProgramTransfer>();
  for (const transfer of transfers) {
    const key = `${transfer.fromAddress}:${transfer.toAddress}:${transfer.kind}:${transfer.callsiteAddress}`;
    if (!unique.has(key)) unique.set(key, transfer);
  }

  diagnostics.unshift(`Program call graph: ${decodedFunctionCount}/${Math.min(functions.length, maxFunctions)} function(s) decoded, ${decodedInstructionCount} instruction(s), ${unique.size} interprocedural transfer(s)${truncated ? ' (budget truncated)' : ''}.`);
  return {
    transfers: [...unique.values()],
    decodedFunctionCount,
    decodedInstructionCount,
    truncated,
    diagnostics
  };
}
