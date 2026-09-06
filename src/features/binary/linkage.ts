import { decodeX86_64 } from '../capstone/capstoneDecoder';
import type { CapstoneModule } from '../capstone/types';
import { executableBytesForRange } from './elfParser';
import type { CanonicalInstruction, ElfPltStub, ElfRelocation, ElfSection, LoadedImage } from './model';

const R_X86_64_GLOB_DAT = 6;
const R_X86_64_JUMP_SLOT = 7;
const R_X86_64_IRELATIVE = 37;
const STT_GNU_IFUNC = 10;

interface CandidateRange {
  start: number;
  end: number;
  size: number;
  section: ElfSection;
}

function relocationRelevant(relocation: ElfRelocation): boolean {
  return relocation.type === R_X86_64_JUMP_SLOT || relocation.type === R_X86_64_GLOB_DAT || relocation.type === R_X86_64_IRELATIVE;
}

function candidateRanges(image: LoadedImage, section: ElfSection): CandidateRange[] {
  const pltRelocations = image.relocations.filter((relocation) =>
    relocationRelevant(relocation) && /\.rel(?:a)?\.plt(?:\.|$)/.test(relocation.sectionName)
  );
  const ranges: CandidateRange[] = [];
  if (section.name === '.plt' && pltRelocations.length && section.size % (pltRelocations.length + 1) === 0) {
    const stride = section.size / (pltRelocations.length + 1);
    if (stride >= 8 && stride <= 64) {
      for (let index = 0; index < pltRelocations.length; index += 1) {
        ranges.push({ start: section.address + stride * (index + 1), end: section.address + stride * (index + 2), size: stride, section });
      }
    }
  } else if (section.name === '.plt.sec' && pltRelocations.length && section.size % pltRelocations.length === 0) {
    const stride = section.size / pltRelocations.length;
    if (stride >= 8 && stride <= 64) {
      for (let index = 0; index < pltRelocations.length; index += 1) {
        ranges.push({ start: section.address + stride * index, end: section.address + stride * (index + 1), size: stride, section });
      }
    }
  } else if (section.name === '.plt.got') {
    const stride = Math.max(1, section.alignment || 8);
    if (stride <= 64 && section.size % stride === 0) {
      for (let offset = 0; offset < section.size; offset += stride) {
        ranges.push({ start: section.address + offset, end: section.address + Math.min(section.size, offset + stride), size: Math.min(stride, section.size - offset), section });
      }
    }
  }
  return ranges;
}

function numberValue(value: number | string): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function ripMemoryTargets(instruction: CanonicalInstruction): number[] {
  const targets: number[] = [];
  for (const memory of instruction.memoryOperands) {
    if (memory.base?.toLowerCase() !== 'rip') continue;
    const displacement = numberValue(memory.displacement);
    if (displacement === null) continue;
    targets.push(instruction.endAddress + displacement);
  }
  return targets;
}

function stubName(image: LoadedImage, relocation: ElfRelocation, address: number): { name: string; symbolName: string | null; ifunc: boolean; resolverAddress: number | null } {
  const symbolName = relocation.symbolName || null;
  const ifuncSymbol = image.symbols.find((symbol) =>
    symbol.defined && symbol.type === STT_GNU_IFUNC && (
      (symbolName && symbol.name === symbolName) ||
      (relocation.type === R_X86_64_IRELATIVE && relocation.addend !== null && symbol.value === relocation.addend)
    )
  ) ?? null;
  const ifunc = relocation.type === R_X86_64_IRELATIVE || ifuncSymbol !== null;
  const resolverAddress = relocation.type === R_X86_64_IRELATIVE && relocation.addend !== null
    ? relocation.addend
    : ifuncSymbol?.value ?? null;
  const base = symbolName || ifuncSymbol?.name || (resolverAddress !== null ? `ifunc_${resolverAddress.toString(16)}` : `plt_${address.toString(16)}`);
  return { name: `${base}@plt`, symbolName: symbolName ?? ifuncSymbol?.name ?? null, ifunc, resolverAddress };
}

export function recoverPltStubs(image: LoadedImage, buffer: ArrayBuffer, module: CapstoneModule): { stubs: ElfPltStub[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const stubs: ElfPltStub[] = [];
  const sections = image.sections.filter((section) => ['.plt', '.plt.sec', '.plt.got'].includes(section.name) && section.executable && section.size > 0);
  const relocationByOffset = new Map<number, ElfRelocation[]>();
  for (const relocation of image.relocations) {
    if (!relocationRelevant(relocation)) continue;
    const list = relocationByOffset.get(relocation.offset) ?? [];
    list.push(relocation);
    relocationByOffset.set(relocation.offset, list);
  }

  for (const section of sections) {
    const ranges = candidateRanges(image, section);
    if (!ranges.length) {
      diagnostics.push(`${section.name}: conservative PLT entry layout could not be proven from section size and relocation count.`);
      continue;
    }
    let decoded: CanonicalInstruction[];
    try {
      const bytes = executableBytesForRange(image, buffer, section.address, section.size);
      decoded = decodeX86_64(module, bytes, section.address, { maxInstructions: Math.max(1024, section.size) });
    } catch (error) {
      diagnostics.push(`${section.name}: Capstone decode failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const range of ranges) {
      const instructions = decoded.filter((instruction) => instruction.address >= range.start && instruction.address < range.end);
      const slots = new Set<number>();
      for (const instruction of instructions) {
        if (instruction.controlFlow !== 'jump' && instruction.controlFlow !== 'call') continue;
        for (const target of ripMemoryTargets(instruction)) if (relocationByOffset.has(target)) slots.add(target);
      }
      if (slots.size !== 1) {
        if (slots.size > 1) diagnostics.push(`${section.name}@0x${range.start.toString(16)}: multiple relocation-backed GOT slots were referenced; PLT stub suppressed.`);
        continue;
      }
      const gotAddress = [...slots][0];
      const relocations = relocationByOffset.get(gotAddress) ?? [];
      const relocation = relocations.find((candidate) => candidate.type === R_X86_64_JUMP_SLOT || candidate.type === R_X86_64_IRELATIVE || candidate.type === R_X86_64_GLOB_DAT);
      if (!relocation) continue;
      const named = stubName(image, relocation, range.start);
      stubs.push({
        address: range.start,
        endAddress: range.end,
        size: range.size,
        name: named.name,
        symbolName: named.symbolName,
        sectionName: section.name,
        gotAddress,
        relocation,
        ifunc: named.ifunc,
        resolverAddress: named.resolverAddress,
        evidence: 'capstone-rip-memory+raw-elf-relocation'
      });
    }
  }

  const unique = [...new Map(stubs.map((stub) => [`${stub.address}:${stub.gotAddress}`, stub])).values()].sort((a, b) => a.address - b.address);
  diagnostics.push(`PLT recovery: ${unique.length} relocation-proven stub(s) from raw ELF bytes.`);
  return { stubs: unique, diagnostics };
}
