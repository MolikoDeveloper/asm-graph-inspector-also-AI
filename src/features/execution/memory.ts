import type { LoadedImage } from '../binary/model';
import type { ExecutionPolicy } from './model';

const PAGE_SIZE = 4096;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type MemoryAccess = 'read' | 'write' | 'execute';

interface MemoryPage {
  bytes: Uint8Array;
  readable: boolean;
  writable: boolean;
  executable: boolean;
  labels: Set<string>;
}

function safeAddress(value: bigint | number, label = 'address'): number {
  const bigint = typeof value === 'bigint' ? value : BigInt(value);
  if (bigint < 0n || bigint > MAX_SAFE_BIGINT) throw new Error(`${label} is outside the browser-safe address range.`);
  return Number(bigint);
}

function pageNumber(address: number): number { return Math.floor(address / PAGE_SIZE); }
function pageOffset(address: number): number { return address % PAGE_SIZE; }

export class SparseVirtualMemory {
  private pages = new Map<number, MemoryPage>();
  private mappedPageBudget: number;

  constructor(maxMappedBytes: number) {
    this.mappedPageBudget = Math.floor(maxMappedBytes / PAGE_SIZE);
    if (this.mappedPageBudget <= 0) throw new Error('Execution memory budget is too small.');
  }

  map(address: number, size: number, permissions: { read: boolean; write: boolean; execute: boolean }, label: string): void {
    if (!Number.isSafeInteger(address) || address < 0 || !Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid mapping ${label}.`);
    if (size === 0) return;
    if (!Number.isSafeInteger(address + size - 1)) throw new Error(`Mapping ${label} exceeds the browser-safe address range.`);
    const start = pageNumber(address);
    const end = pageNumber(address + size - 1);
    for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
      let page = this.pages.get(pageIndex);
      if (!page) {
        if (this.pages.size >= this.mappedPageBudget) throw new Error(`Execution mapping exceeds ${this.mappedPageBudget * PAGE_SIZE} bytes policy budget.`);
        page = { bytes: new Uint8Array(PAGE_SIZE), readable: false, writable: false, executable: false, labels: new Set() };
        this.pages.set(pageIndex, page);
      }
      page.readable ||= permissions.read;
      page.writable ||= permissions.write;
      page.executable ||= permissions.execute;
      page.labels.add(label);
    }
  }

  load(address: number, bytes: Uint8Array): void {
    for (let index = 0; index < bytes.length; index += 1) {
      const absolute = address + index;
      const page = this.pages.get(pageNumber(absolute));
      if (!page) throw new Error(`Loader attempted to write unmapped memory at 0x${absolute.toString(16)}.`);
      page.bytes[pageOffset(absolute)] = bytes[index];
    }
  }

  private pageFor(address: number, access: MemoryAccess): MemoryPage {
    const page = this.pages.get(pageNumber(address));
    if (!page) throw new Error(`Unmapped ${access} at 0x${address.toString(16)}.`);
    const allowed = access === 'read' ? page.readable : access === 'write' ? page.writable : page.executable;
    if (!allowed) throw new Error(`Memory protection fault: ${access} at 0x${address.toString(16)} (${[...page.labels].join(', ') || 'unnamed mapping'}).`);
    return page;
  }

  read(addressValue: bigint | number, size: number, access: MemoryAccess = 'read'): Uint8Array {
    const address = safeAddress(addressValue);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid memory read size.');
    const result = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      const absolute = address + index;
      const page = this.pageFor(absolute, access);
      result[index] = page.bytes[pageOffset(absolute)];
    }
    return result;
  }

  readExecutableWindow(addressValue: bigint | number, maximum = 15): Uint8Array {
    const address = safeAddress(addressValue, 'instruction address');
    const result: number[] = [];
    for (let index = 0; index < maximum; index += 1) {
      const absolute = address + index;
      try {
        const page = this.pageFor(absolute, 'execute');
        result.push(page.bytes[pageOffset(absolute)]);
      } catch (error) {
        if (index === 0) throw error;
        break;
      }
    }
    return Uint8Array.from(result);
  }

  write(addressValue: bigint | number, bytes: Uint8Array): void {
    const address = safeAddress(addressValue);
    for (let index = 0; index < bytes.length; index += 1) {
      const absolute = address + index;
      const page = this.pageFor(absolute, 'write');
      page.bytes[pageOffset(absolute)] = bytes[index];
    }
  }

  readUnsigned(address: bigint | number, size: number): bigint {
    const bytes = this.read(address, size, 'read');
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
    return value;
  }

  writeUnsigned(address: bigint | number, size: number, value: bigint): void {
    const bytes = new Uint8Array(size);
    let remaining = value;
    for (let index = 0; index < size; index += 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.write(address, bytes);
  }
}

export interface LoadedExecutionMemory {
  memory: SparseVirtualMemory;
  stackTop: number;
  stackBase: number;
}

export function loadElfExecutionMemory(image: LoadedImage, buffer: ArrayBuffer, policy: ExecutionPolicy): LoadedExecutionMemory {
  const memory = new SparseVirtualMemory(policy.maxMappedBytes);
  const source = new Uint8Array(buffer);
  for (const segment of image.segments) {
    if (!segment.memorySize) continue;
    memory.map(segment.virtualAddress, segment.memorySize, {
      read: segment.readable,
      write: segment.writable,
      execute: segment.executable
    }, `PT_LOAD #${segment.index}`);
    if (segment.fileSize) {
      const start = segment.offset;
      const end = start + segment.fileSize;
      if (start < 0 || end > source.byteLength) throw new Error(`PT_LOAD #${segment.index} exceeds the source ELF bytes.`);
      memory.load(segment.virtualAddress, source.subarray(start, end));
    }
  }

  const stackTop = 0x7fff_ffff_f000;
  const stackBase = stackTop - policy.stackBytes;
  memory.map(stackBase, policy.stackBytes, { read: true, write: true, execute: false }, 'process stack');
  return { memory, stackTop, stackBase };
}

export function numberAddress(value: bigint, label = 'address'): number { return safeAddress(value, label); }
