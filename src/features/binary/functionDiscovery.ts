import { decodeX86_64 } from '../capstone/capstoneDecoder';
import type { CapstoneModule } from '../capstone/types';
import { executableBytesForRange } from './elfParser';
import type {
  BinaryFunctionCandidate,
  CanonicalInstruction,
  ElfSection,
  ElfUnwindFde,
  LoadedImage
} from './model';

const PLT_SECTIONS = new Set(['.plt', '.plt.sec', '.plt.got']);
const SEED_RANK: Record<BinaryFunctionCandidate['kind'], number> = {
  symbol: 0,
  'unwind-fde': 1,
  entrypoint: 2,
  'section-entry': 3,
  'direct-call': 4,
  'tail-call': 5,
  prologue: 6,
  'cet-landing-pad': 7,
  'aligned-after-return': 8
};

interface Seed {
  address: number;
  section: ElfSection;
  kind: Exclude<BinaryFunctionCandidate['kind'], 'symbol'>;
  confidence: 'inferred' | 'heuristic';
  evidence: string;
  rangeEnd: number | null;
  unwindFde: ElfUnwindFde | null;
  leadingPaddingBytes: number;
}

interface TraceResult {
  instructions: CanonicalInstruction[];
  callTargets: Array<{ address: number; section: ElfSection }>;
  tailTargets: Array<{ address: number; section: ElfSection }>;
}

export interface FunctionDiscoveryResult {
  functions: BinaryFunctionCandidate[];
  decodedBySection: Map<number, CanonicalInstruction[]>;
  diagnostics: string[];
  mode: 'symbol-backed' | 'fde-priority-recursive-descent';
}

function executableSections(image: LoadedImage): ElfSection[] {
  return image.sections.filter((section) => section.executable && section.size > 0 && !PLT_SECTIONS.has(section.name));
}

function sectionForAddress(sections: ElfSection[], address: number): ElfSection | null {
  return sections.find((section) => address >= section.address && address < section.address + section.size) ?? null;
}

function exactInstructionMap(instructions: CanonicalInstruction[]): Map<number, CanonicalInstruction> {
  return new Map(instructions.map((instruction) => [instruction.address, instruction]));
}

function isNopLike(instruction: CanonicalInstruction): boolean {
  const mnemonic = instruction.mnemonic.toLowerCase();
  if (/^nop(?:l|w|q)?$/.test(mnemonic)) return true;
  if (mnemonic !== 'xchg' || instruction.operandDetails.length !== 2) return false;
  const [left, right] = instruction.operandDetails;
  return left.kind === 'register' && right.kind === 'register' && left.register !== null && left.register === right.register;
}

function normalizeFdeEntry(fde: ElfUnwindFde, instructions: CanonicalInstruction[], maxPaddingBytes = 32): { address: number; leadingPaddingBytes: number } {
  const byAddress = exactInstructionMap(instructions);
  let current = byAddress.get(fde.startAddress);
  if (!current) return { address: fde.startAddress, leadingPaddingBytes: 0 };
  let padding = 0;
  while (current && current.address < fde.endAddress) {
    if (current.mnemonic.toLowerCase() === 'endbr64' || current.mnemonic.toLowerCase() === 'endbr32') break;
    if (!isNopLike(current) || padding + current.size > maxPaddingBytes) break;
    padding += current.size;
    current = byAddress.get(current.endAddress);
  }
  if (!current || current.address >= fde.endAddress || padding === 0) return { address: fde.startAddress, leadingPaddingBytes: 0 };
  return { address: current.address, leadingPaddingBytes: padding };
}

function addSeed(seeds: Map<number, Seed>, seed: Seed): boolean {
  if (!Number.isSafeInteger(seed.address) || seed.address < 0 || PLT_SECTIONS.has(seed.section.name)) return false;
  const previous = seeds.get(seed.address);
  if (previous && SEED_RANK[previous.kind] <= SEED_RANK[seed.kind]) return false;
  seeds.set(seed.address, seed);
  return true;
}

function strictFdeCoverage(address: number, fdes: ElfUnwindFde[]): ElfUnwindFde | null {
  return fdes.find((fde) => address > fde.startAddress && address < fde.endAddress) ?? null;
}

function preferredFdes(image: LoadedImage, sections: ElfSection[]): ElfUnwindFde[] {
  const sourceRank = (fde: ElfUnwindFde) => fde.source === 'debug_frame' ? 0 : 1;
  const candidates = image.unwind.fdes
    .filter((fde) => fde.endAddress > fde.startAddress && sectionForAddress(sections, fde.startAddress))
    .sort((a, b) => a.startAddress - b.startAddress || sourceRank(a) - sourceRank(b) || b.endAddress - a.endAddress);
  const byStart = new Map<number, ElfUnwindFde>();
  for (const fde of candidates) {
    const previous = byStart.get(fde.startAddress);
    if (!previous || sourceRank(fde) < sourceRank(previous) || (sourceRank(fde) === sourceRank(previous) && fde.endAddress > previous.endAddress)) byStart.set(fde.startAddress, fde);
  }
  const accepted: ElfUnwindFde[] = [];
  for (const fde of [...byStart.values()].sort((a, b) => a.startAddress - b.startAddress || a.endAddress - b.endAddress)) {
    if (accepted.some((other) => fde.startAddress < other.endAddress && fde.endAddress > other.startAddress)) continue;
    accepted.push(fde);
  }
  return accepted;
}

function addHeuristicSeeds(instructions: CanonicalInstruction[], section: ElfSection, seeds: Map<number, Seed>, fdes: ElfUnwindFde[]): void {
  const add = (address: number, kind: Seed['kind'], evidence: string) => {
    if (strictFdeCoverage(address, fdes)) return;
    addSeed(seeds, { address, section, kind, confidence: 'heuristic', evidence, rangeEnd: null, unwindFde: null, leadingPaddingBytes: 0 });
  };

  for (let index = 0; index < instructions.length; index += 1) {
    const current = instructions[index];
    const next = instructions[index + 1];
    const third = instructions[index + 2];
    const mnemonic = current.mnemonic.toLowerCase();
    if (mnemonic === 'endbr64' || mnemonic === 'endbr32') add(current.address, 'cet-landing-pad', 'CET ENDBR landing pad decoded from executable bytes.');
    if (
      next && mnemonic === 'push' && current.operandDetails[0]?.kind === 'register' && current.operandDetails[0].register === 'rbp' &&
      next.mnemonic.toLowerCase() === 'mov' && next.operandDetails[0]?.kind === 'register' && next.operandDetails[0].register === 'rbp' &&
      next.operandDetails[1]?.kind === 'register' && next.operandDetails[1].register === 'rsp'
    ) add(current.address, 'prologue', 'x86 frame-pointer prologue decoded from executable bytes.');
    if (
      third && mnemonic === 'endbr64' && next?.mnemonic.toLowerCase() === 'push' && next.operandDetails[0]?.kind === 'register' && next.operandDetails[0].register === 'rbp' &&
      third.mnemonic.toLowerCase() === 'mov' && third.operandDetails[0]?.kind === 'register' && third.operandDetails[0].register === 'rbp' &&
      third.operandDetails[1]?.kind === 'register' && third.operandDetails[1].register === 'rsp'
    ) add(current.address, 'prologue', 'CET ENDBR + frame-pointer prologue decoded from executable bytes.');
    if (current.controlFlow === 'return') {
      let cursor = index + 1;
      while (cursor < instructions.length && isNopLike(instructions[cursor])) cursor += 1;
      const candidate = instructions[cursor];
      if (candidate && candidate.address % 16 === 0) add(candidate.address, 'aligned-after-return', '16-byte-aligned executable code after RET/NOP padding.');
    }
  }
}

function isUnconditionalJump(instruction: CanonicalInstruction): boolean {
  return instruction.controlFlow === 'jump' && /^(?:jmp|jmpq|ljmp)$/i.test(instruction.mnemonic);
}

function isTerminal(instruction: CanonicalInstruction): boolean {
  return instruction.controlFlow === 'return' || /^(?:ret|retf|iret|iretq|ud2|hlt)$/i.test(instruction.mnemonic);
}

function traceSeed(
  seed: Seed,
  indexes: Map<number, { section: ElfSection; instruction: CanonicalInstruction }>,
  seeds: Map<number, Seed>,
  fdes: ElfUnwindFde[]
): TraceResult {
  const queue = [seed.address];
  const visited = new Map<number, CanonicalInstruction>();
  const callTargets: TraceResult['callTargets'] = [];
  const tailTargets: TraceResult['tailTargets'] = [];
  const sectionEnd = seed.section.address + seed.section.size;
  const hardEnd = seed.rangeEnd ?? sectionEnd;

  while (queue.length) {
    let address = queue.shift()!;
    for (let steps = 0; steps < 131072; steps += 1) {
      if (address < seed.section.address || address >= hardEnd) break;
      if (visited.has(address)) break;
      const hit = indexes.get(address);
      if (!hit || hit.section.index !== seed.section.index) break;
      const instruction = hit.instruction;
      visited.set(address, instruction);

      if (instruction.controlFlow === 'call' && instruction.directTarget !== null) {
        const target = indexes.get(instruction.directTarget);
        if (target) callTargets.push({ address: instruction.directTarget, section: target.section });
      }

      if (instruction.controlFlow === 'jump' && instruction.directTarget !== null) {
        const target = indexes.get(instruction.directTarget);
        if (target) {
          if (isUnconditionalJump(instruction)) {
            const independentlySupported = seeds.has(instruction.directTarget) || fdes.some((fde) => fde.startAddress === instruction.directTarget) || /^(?:endbr64|endbr32)$/i.test(target.instruction.mnemonic);
            if (independentlySupported && (instruction.directTarget < seed.address || instruction.directTarget >= hardEnd)) {
              tailTargets.push({ address: instruction.directTarget, section: target.section });
              break;
            }
            if (instruction.directTarget >= seed.section.address && instruction.directTarget < hardEnd) queue.push(instruction.directTarget);
            break;
          }
          if (instruction.directTarget >= seed.section.address && instruction.directTarget < hardEnd) queue.push(instruction.directTarget);
        }
      }

      if (isTerminal(instruction)) break;
      address = instruction.endAddress;
    }
  }

  return {
    instructions: [...visited.values()].sort((a, b) => a.address - b.address),
    callTargets,
    tailTargets
  };
}

function candidateFromSymbol(image: LoadedImage, symbolIndex: number): BinaryFunctionCandidate {
  const symbol = image.functions[symbolIndex];
  const section = image.sections[symbol.sectionIndex];
  return {
    address: symbol.value,
    endAddress: symbol.size > 0 ? symbol.value + symbol.size : null,
    size: symbol.size || null,
    name: symbol.name || `sub_${symbol.value.toString(16)}`,
    sectionIndex: symbol.sectionIndex,
    sectionName: section?.name ?? '',
    kind: 'symbol',
    confidence: 'exact',
    evidence: symbol.type === 10 ? 'raw ELF STT_GNU_IFUNC symbol' : 'raw ELF STT_FUNC symbol',
    symbol,
    unwindFde: image.unwind.fdes.find((fde) => fde.startAddress === symbol.value) ?? null,
    leadingPaddingBytes: 0
  };
}

export function decodeFunctionCandidate(
  image: LoadedImage,
  buffer: ArrayBuffer,
  module: CapstoneModule,
  candidate: BinaryFunctionCandidate,
  maxInstructions = 16384
): CanonicalInstruction[] {
  const section = image.sections[candidate.sectionIndex];
  if (!section?.executable) throw new Error(`Function ${candidate.name} is not inside an executable section.`);
  const sectionEnd = section.address + section.size;
  const rangeEnd = candidate.endAddress ?? sectionEnd;
  const byteLength = Math.max(1, Math.min(rangeEnd - candidate.address, sectionEnd - candidate.address, 1024 * 1024));
  const bytes = executableBytesForRange(image, buffer, candidate.address, byteLength);
  return decodeX86_64(module, bytes, candidate.address, { maxInstructions, stopAtReturn: candidate.endAddress === null });
}

export function discoverBinaryFunctions(
  image: LoadedImage,
  buffer: ArrayBuffer,
  module: CapstoneModule,
  options: { maxScanBytes?: number; maxFunctions?: number; maxPasses?: number } = {}
): FunctionDiscoveryResult {
  if (image.functions.length) {
    return {
      functions: image.functions.map((_, index) => candidateFromSymbol(image, index)),
      decodedBySection: new Map(),
      diagnostics: [`Function discovery: ${image.functions.length} raw ELF symbol-backed function(s); stripped heuristics suppressed.`],
      mode: 'symbol-backed'
    };
  }

  const maxScanBytes = options.maxScanBytes ?? 1024 * 1024;
  const maxFunctions = options.maxFunctions ?? 4096;
  const maxPasses = options.maxPasses ?? 16;
  const sections = executableSections(image);
  const decodedBySection = new Map<number, CanonicalInstruction[]>();
  const diagnostics: string[] = [];
  let scanBytes = 0;

  for (const section of sections) {
    if (scanBytes + section.size > maxScanBytes) {
      diagnostics.push(`Function discovery skipped ${section.name}: executable scan budget ${maxScanBytes} bytes would be exceeded.`);
      continue;
    }
    scanBytes += section.size;
    try {
      const bytes = executableBytesForRange(image, buffer, section.address, section.size);
      decodedBySection.set(section.index, decodeX86_64(module, bytes, section.address, { maxInstructions: Math.min(262144, Math.max(4096, section.size)) }));
    } catch (error) {
      diagnostics.push(`Function discovery could not decode ${section.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const decodedIndex = new Map<number, { section: ElfSection; instruction: CanonicalInstruction }>();
  for (const section of sections) {
    for (const instruction of decodedBySection.get(section.index) ?? []) decodedIndex.set(instruction.address, { section, instruction });
  }

  const fdes = preferredFdes(image, sections);
  const seeds = new Map<number, Seed>();
  for (const fde of fdes) {
    const section = sectionForAddress(sections, fde.startAddress);
    if (!section) continue;
    const normalized = normalizeFdeEntry(fde, decodedBySection.get(section.index) ?? []);
    addSeed(seeds, {
      address: normalized.address,
      section,
      kind: 'unwind-fde',
      confidence: 'inferred',
      evidence: `${fde.source} FDE gives exact unwind coverage 0x${fde.startAddress.toString(16)}..0x${fde.endAddress.toString(16)}; semantic function identity remains inferred.`,
      rangeEnd: fde.endAddress,
      unwindFde: fde,
      leadingPaddingBytes: normalized.leadingPaddingBytes
    });
  }

  const entrySection = sectionForAddress(sections, image.entry);
  if (entrySection) {
    addSeed(seeds, {
      address: image.entry,
      section: entrySection,
      kind: 'entrypoint',
      confidence: 'inferred',
      evidence: 'ELF e_entry exact address; function identity inferred from executable control flow.',
      rangeEnd: null,
      unwindFde: null,
      leadingPaddingBytes: 0
    });
  }

  for (const section of sections) {
    if (section.name === '.init' || section.name === '.fini') {
      addSeed(seeds, {
        address: section.address,
        section,
        kind: 'section-entry',
        confidence: 'inferred',
        evidence: `${section.name} executable section start.`,
        rangeEnd: section.address + section.size,
        unwindFde: null,
        leadingPaddingBytes: 0
      });
    }
    addHeuristicSeeds(decodedBySection.get(section.index) ?? [], section, seeds, fdes);
  }

  const traces = new Map<number, TraceResult>();
  let changed = true;
  let pass = 0;
  while (changed && pass < maxPasses && seeds.size < maxFunctions) {
    changed = false;
    pass += 1;
    const current = [...seeds.values()].sort((a, b) => SEED_RANK[a.kind] - SEED_RANK[b.kind] || a.address - b.address).slice(0, maxFunctions);
    for (const seed of current) {
      if (seed.kind !== 'unwind-fde' && strictFdeCoverage(seed.address, fdes)) continue;
      const trace = traceSeed(seed, decodedIndex, seeds, fdes);
      traces.set(seed.address, trace);
      for (const target of trace.callTargets) {
        if (strictFdeCoverage(target.address, fdes) && !seeds.has(target.address)) continue;
        changed = addSeed(seeds, {
          address: target.address,
          section: target.section,
          kind: 'direct-call',
          confidence: 'inferred',
          evidence: `reachable direct CALL target from canonical Capstone decode.`,
          rangeEnd: null,
          unwindFde: null,
          leadingPaddingBytes: 0
        }) || changed;
      }
      for (const target of trace.tailTargets) {
        if (strictFdeCoverage(target.address, fdes) && !seeds.has(target.address)) continue;
        changed = addSeed(seeds, {
          address: target.address,
          section: target.section,
          kind: 'tail-call',
          confidence: 'inferred',
          evidence: 'terminal JMP reaches an independently supported executable entry.',
          rangeEnd: null,
          unwindFde: null,
          leadingPaddingBytes: 0
        }) || changed;
      }
    }
  }
  if (changed) diagnostics.push(`Function discovery stopped after ${maxPasses} recursive passes.`);

  const accepted = [...seeds.values()]
    .filter((seed) => seed.kind === 'unwind-fde' || !strictFdeCoverage(seed.address, fdes))
    .sort((a, b) => a.address - b.address || SEED_RANK[a.kind] - SEED_RANK[b.kind])
    .slice(0, maxFunctions);
  const bySection = new Map<number, number[]>();
  for (const seed of accepted) {
    const list = bySection.get(seed.section.index) ?? [];
    list.push(seed.address);
    bySection.set(seed.section.index, list);
  }
  for (const list of bySection.values()) list.sort((a, b) => a - b);

  const functions: BinaryFunctionCandidate[] = [];
  for (const seed of accepted) {
    const trace = traces.get(seed.address) ?? traceSeed(seed, decodedIndex, seeds, fdes);
    const starts = bySection.get(seed.section.index) ?? [];
    const nextStart = starts.find((address) => address > seed.address) ?? null;
    const sectionEnd = seed.section.address + seed.section.size;
    const hardEnd = seed.rangeEnd ?? nextStart ?? sectionEnd;
    const reachable = trace.instructions.filter((instruction) => instruction.address >= seed.address && instruction.address < hardEnd);
    const observedEnd = reachable.length ? Math.max(...reachable.map((instruction) => instruction.endAddress)) : seed.address;
    const endAddress = seed.rangeEnd ?? (observedEnd > seed.address ? Math.min(hardEnd, observedEnd) : hardEnd);
    if (endAddress <= seed.address) continue;
    functions.push({
      address: seed.address,
      endAddress,
      size: endAddress - seed.address,
      name: `sub_${seed.address.toString(16)}`,
      sectionIndex: seed.section.index,
      sectionName: seed.section.name,
      kind: seed.kind,
      confidence: seed.confidence,
      evidence: seed.evidence,
      symbol: null,
      unwindFde: seed.unwindFde,
      leadingPaddingBytes: seed.leadingPaddingBytes
    });
  }

  diagnostics.push(`Function discovery: ${functions.length} candidate(s), ${fdes.length} preferred FDE claim(s), ${scanBytes} executable byte(s) scanned in ${pass} pass(es).`);
  diagnostics.push(...image.unwind.errors.map((error) => `Unwind parse diagnostic: ${error}`));
  return { functions, decodedBySection, diagnostics, mode: 'fde-priority-recursive-descent' };
}
