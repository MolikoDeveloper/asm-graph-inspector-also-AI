import type { ProjectFile } from '../project/model';
import { parseElfImage, executableBytesForRange } from '../binary/elfParser';
import { loadCapstone } from '../capstone/capstoneLoader';
import { decodeX86_64 } from '../capstone/capstoneDecoder';

export interface BinaryDisassemblyLine {
  address: number;
  endAddress: number;
  bytes: number[];
  mnemonic: string;
  operands: string;
  sectionName: string;
  symbolName: string | null;
}

export interface BinaryDisassemblyDocument {
  fileId: string;
  signature: string;
  lines: BinaryDisassemblyLine[];
  sectionCount: number;
  decodedBytes: number;
  skippedBytes: number;
}

const cache = new Map<string, BinaryDisassemblyDocument>();

function signature(file: ProjectFile) {
  return `${file.id}:${file.size}:${file.updatedAt}`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function loadFullBinaryDisassembly(file: ProjectFile, onProgress?: (completed: number, total: number) => void): Promise<BinaryDisassemblyDocument> {
  if (file.kind !== 'binary' || !file.bytes) throw new Error('Disassembly requires an imported binary file.');
  const fileSignature = signature(file);
  const existing = cache.get(file.id);
  if (existing?.signature === fileSignature) return existing;

  const image = parseElfImage(file.id, file.path, file.bytes);
  const module = await loadCapstone();
  const sections = image.sections.filter((section) => section.executable && section.size > 0 && section.allocated).sort((left, right) => left.address - right.address);
  const symbols = image.symbols.filter((symbol) => symbol.defined && symbol.value > 0 && symbol.name).sort((left, right) => left.value - right.value);
  const symbolByAddress = new Map(symbols.map((symbol) => [symbol.value, symbol.name]));
  const total = sections.reduce((sum, section) => sum + section.size, 0);
  let completed = 0;
  let decodedBytes = 0;
  let skippedBytes = 0;
  const lines: BinaryDisassemblyLine[] = [];
  const chunkSize = 96 * 1024;
  let yields = 0;

  for (const section of sections) {
    let cursor = section.address;
    const end = section.address + section.size;
    while (cursor < end) {
      const requested = Math.min(chunkSize, end - cursor);
      let bytes: Uint8Array;
      try {
        bytes = executableBytesForRange(image, file.bytes, cursor, requested);
      } catch {
        const skip = Math.min(requested, end - cursor);
        cursor += skip;
        completed += skip;
        skippedBytes += skip;
        continue;
      }
      const decoded = decodeX86_64(module, bytes, cursor, { maxInstructions: 32768 });
      if (!decoded.length) {
        cursor += 1;
        completed += 1;
        skippedBytes += 1;
      } else {
        for (const instruction of decoded) {
          if (instruction.address >= end) break;
          lines.push({
            address: instruction.address,
            endAddress: instruction.endAddress,
            bytes: instruction.bytes,
            mnemonic: instruction.mnemonic,
            operands: instruction.operands,
            sectionName: section.name,
            symbolName: symbolByAddress.get(instruction.address) ?? null
          });
        }
        const last = decoded.at(-1)!;
        const advanced = Math.max(1, Math.min(end, last.endAddress) - cursor);
        cursor += advanced;
        completed += advanced;
        decodedBytes += advanced;
      }
      onProgress?.(Math.min(completed, total), total);
      yields += 1;
      if (yields % 4 === 0) await nextFrame();
    }
  }

  const document: BinaryDisassemblyDocument = { fileId: file.id, signature: fileSignature, lines, sectionCount: sections.length, decodedBytes, skippedBytes };
  cache.set(file.id, document);
  return document;
}

export function clearFullDisassemblyCache(fileId?: string) {
  if (fileId) cache.delete(fileId);
  else cache.clear();
}
