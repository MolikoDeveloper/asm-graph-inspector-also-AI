import type { CanonicalInstruction, LoadedImage } from '../binary/model';
import { parseElfImage } from '../binary/elfParser';
import { createX86_64InstructionDecoder, type X86_64InstructionDecoder } from '../capstone/capstoneDecoder';
import { loadCapstone } from '../capstone/capstoneLoader';
import type { CapstoneModule } from '../capstone/types';
import type { ProjectFile } from '../project/model';
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionEvent,
  type ExecutionInstructionSnapshot,
  type ExecutionPolicy,
  type ExecutionProviderDiagnostic,
  type ExecutionRegisterSnapshot,
  type ExecutionRuntimeDisassemblySnapshot,
  type ExecutionRuntimeImageSnapshot,
  type ExecutionSnapshot,
  type ExecutionStatus
} from './model';
import {
  assertPreparedLinuxRuntimeEnvironmentMatches,
  type PreparedLinuxRuntimeEnvironment
} from './linuxRuntimeEnvironment';
import type { MaterializedRuntimeModule } from './runtimeDependencies';
import { loadUnicornX86 } from './unicornLoader';
import type { UnicornEngine, UnicornHook, UnicornModule } from './unicornTypes';

const PAGE_SIZE = 4096;
const STACK_TOP = 0x0000_7fff_ffff_f000;
const PIE_BASE = 0x0000_5555_5555_4000;
const INTERPRETER_BASE = 0x0000_7f00_0000_0000;
const MMAP_BASE = 0x0000_7000_0000_0000;
const MAX_IO_BYTES = 1024 * 1024;
const MAX_IOV_COUNT = 1024;
const IOVEC_SIZE = 16;
const MAX_PATH_BYTES = 4096;
const MAX_X86_INSTRUCTION_BYTES = 15;
const EMULATION_UNTIL = 0xffff_ffff_ffff_ffffn;

const SYS_READ = 0;
const SYS_WRITE = 1;
const SYS_OPEN = 2;
const SYS_CLOSE = 3;
const SYS_STAT = 4;
const SYS_FSTAT = 5;
const SYS_LSEEK = 8;
const SYS_MMAP = 9;
const SYS_MPROTECT = 10;
const SYS_MUNMAP = 11;
const SYS_BRK = 12;
const SYS_RT_SIGACTION = 13;
const SYS_RT_SIGPROCMASK = 14;
const SYS_IOCTL = 16;
const SYS_PREAD64 = 17;
const SYS_WRITEV = 20;
const SYS_ACCESS = 21;
const SYS_MREMAP = 25;
const SYS_MADVISE = 28;
const SYS_GETPID = 39;
const SYS_UNAME = 63;
const SYS_GETCWD = 79;
const SYS_READLINK = 89;
const SYS_GETUID = 102;
const SYS_GETGID = 104;
const SYS_GETEUID = 107;
const SYS_GETEGID = 108;
const SYS_ARCH_PRCTL = 158;
const SYS_GETTID = 186;
const SYS_FUTEX = 202;
const SYS_SET_TID_ADDRESS = 218;
const SYS_CLOCK_GETTIME = 228;
const SYS_EXIT = 60;
const SYS_EXIT_GROUP = 231;
const SYS_OPENAT = 257;
const SYS_NEWFSTATAT = 262;
const SYS_READLINKAT = 267;
const SYS_SET_ROBUST_LIST = 273;
const SYS_PRLIMIT64 = 302;
const SYS_GETRANDOM = 318;
const SYS_RSEQ = 334;

const AT_FDCWD = -100;
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;
const MAP_FIXED = 0x10;
const MAP_ANONYMOUS = 0x20;
const MAP_FIXED_NOREPLACE = 0x100000;
const MREMAP_MAYMOVE = 0x1;
const MREMAP_FIXED = 0x2;
const FUTEX_WAIT = 0;
const FUTEX_WAKE = 1;
const FUTEX_CMD_MASK = 0x7f;
const ARCH_SET_GS = 0x1001;
const ARCH_SET_FS = 0x1002;
const ARCH_GET_FS = 0x1003;
const ARCH_GET_GS = 0x1004;
const ENOENT = 2;
const EBADF = 9;
const EAGAIN = 11;
const ENOMEM = 12;
const EACCES = 13;
const EFAULT = 14;
const EINVAL = 22;
const ENOTTY = 25;
const ENOSYS = 38;

interface ElfKernelHeader {
  phoff: number;
  phentsize: number;
  phnum: number;
  phdrAddress: number;
}

interface VirtualFile {
  path: string;
  name: string;
  bytes: Uint8Array;
  role: 'program' | 'interpreter' | 'dependency';
  image: LoadedImage | null;
}

interface OpenFile {
  file: VirtualFile;
  position: number;
}

interface RuntimeImageMapping {
  file: VirtualFile;
  runtimeStart: number;
  runtimeEnd: number;
  imageStart: number;
  loadBias: number;
}

interface FileBackedMapping {
  file: VirtualFile;
  address: number;
  size: number;
  fileOffset: number;
}

interface AnonymousMapping {
  address: number;
  size: number;
  permissions: number;
}

function appendEvent(events: ExecutionEvent[], event: ExecutionEvent): void {
  events.push(event);
  if (events.length > 600) events.splice(0, events.length - 600);
}

function terminal(status: ExecutionStatus): boolean {
  return status === 'exited' || status === 'halted' || status === 'trapped';
}

function alignDown(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function normalizePath(path: string): string {
  if (!path) return '/';
  const absolute = path.startsWith('/') ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is outside the browser-safe integer range.`);
  return number;
}

/**
 * Do not use Unicorn's code-hook size as the Capstone input length: VEX/BMI
 * translations can report a truncated size. Read the x86 maximum and shrink
 * only when the next page is unmapped.
 */
function instructionBytes(engine: UnicornEngine, address: bigint): Uint8Array {
  for (let length = MAX_X86_INSTRUCTION_BYTES; length >= 1; length -= 1) {
    try { return engine.mem_read(address, length); }
    catch { /* a short instruction can end at an unmapped page boundary */ }
  }
  throw new Error(`Unable to read Unicorn instruction bytes at 0x${address.toString(16)}.`);
}

function signedNumber(value: bigint): number {
  return Number(BigInt.asIntN(64, value));
}

function writeU32(engine: UnicornEngine, address: number, value: number): void {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  engine.mem_write(address, bytes);
}

function writeU64(engine: UnicornEngine, address: number, value: bigint | number): void {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(value)), true);
  engine.mem_write(address, bytes);
}

function writeTimespec(engine: UnicornEngine, address: number, milliseconds: number): void {
  const seconds = Math.floor(milliseconds / 1000);
  const nanoseconds = Math.floor((milliseconds - seconds * 1000) * 1_000_000);
  writeU64(engine, address, seconds);
  writeU64(engine, address + 8, nanoseconds);
}

function writeUtsName(engine: UnicornEngine, address: number): void {
  const fields = ['Linux', 'asm-graph', '6.0.0-browser', '#1 virtual userspace', 'x86_64', 'localdomain'];
  const bytes = new Uint8Array(65 * fields.length);
  const encoder = new TextEncoder();
  fields.forEach((field, index) => bytes.set(encoder.encode(field).subarray(0, 64), index * 65));
  engine.mem_write(address, bytes);
}

function linuxProtection(module: UnicornModule, protection: number): number {
  return (protection & 1 ? module.PROT_READ : 0)
    | (protection & 2 ? module.PROT_WRITE : 0)
    | (protection & 4 ? module.PROT_EXEC : 0);
}

function segmentPermissions(module: UnicornModule, image: LoadedImage, segmentIndex: number): number {
  const segment = image.segments[segmentIndex];
  return (segment.readable ? module.PROT_READ : 0)
    | (segment.writable ? module.PROT_WRITE : 0)
    | (segment.executable ? module.PROT_EXEC : 0);
}

function chooseLoadBias(image: LoadedImage, base: number): number {
  const minimum = Math.min(...image.segments.map((segment) => alignDown(segment.virtualAddress, PAGE_SIZE)));
  return alignDown(base, PAGE_SIZE) - minimum;
}

function parseKernelHeader(bytes: ArrayBuffer, image: LoadedImage, loadBias: number): ElfKernelHeader {
  if (bytes.byteLength < 64) throw new Error('ELF64 header is truncated.');
  const view = new DataView(bytes);
  const phoff = safeNumber(view.getBigUint64(32, true), 'program-header offset');
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  if (phentsize < 56 || !phnum) throw new Error('ELF does not expose a usable program-header table.');
  const segment = image.segments.find((candidate) => phoff >= candidate.offset && phoff < candidate.offset + candidate.fileSize);
  if (!segment) throw new Error('ELF program-header table is not backed by a PT_LOAD mapping.');
  return {
    phoff,
    phentsize,
    phnum,
    phdrAddress: loadBias + segment.virtualAddress + (phoff - segment.offset)
  };
}

function virtualFileFromModule(module: MaterializedRuntimeModule, role: 'interpreter' | 'dependency'): VirtualFile {
  let image: LoadedImage | null = null;
  try { image = parseElfImage(`runtime:${module.sourceId}:${module.fileName}`, module.fileName, module.bytes); }
  catch { image = null; }
  return { path: `/${module.fileName}`, name: module.fileName, bytes: new Uint8Array(module.bytes), role, image };
}

export class UnicornLinuxProcessSession {
  private statusValue: ExecutionStatus = 'ready';
  private instructionCountValue = 0;
  private lastInstructionValue: ExecutionInstructionSnapshot | null = null;
  private runtimeDisassemblyValue: ExecutionRuntimeDisassemblySnapshot | null = null;
  private stdoutValue = '';
  private stderrValue = '';
  private exitCodeValue: number | null = null;
  private trapReasonValue: string | null = null;
  private eventsValue: ExecutionEvent[] = [];
  private providerDiagnosticsValue: ExecutionProviderDiagnostic[] = [];
  private readonly engine: UnicornEngine;
  private readonly decoder: X86_64InstructionDecoder;
  private codeHook: UnicornHook | null = null;
  private disposed = false;
  private mappedPages = new Set<number>();
  private mappedBytesValue = 0;
  private heapBaseValue = 0;
  private programBreakValue = 0;
  private mmapCursorValue = MMAP_BASE;
  private nextFdValue = 3;
  private openFiles = new Map<number, OpenFile>();
  private filesByPath = new Map<string, VirtualFile>();
  private runtimeMappings: RuntimeImageMapping[] = [];
  private fileMappings: FileBackedMapping[] = [];
  private anonymousMappings: AnonymousMapping[] = [];
  private lastInstructionRole: RuntimeImageMapping['file']['role'] | null = null;
  stdinBytes: Uint8Array;
  stdinCursor = 0;

  private constructor(
    readonly file: ProjectFile,
    readonly image: LoadedImage,
    readonly environment: PreparedLinuxRuntimeEnvironment,
    private readonly unicorn: UnicornModule,
    capstone: CapstoneModule,
    readonly policy: ExecutionPolicy
  ) {
    if (file.kind !== 'binary' || !file.bytes) throw new Error('Unicorn Linux execution requires authoritative ELF bytes.');
    if (image.architecture !== 'x86-64') throw new Error(`Unicorn Linux x86 backend cannot execute ${image.architecture}.`);
    if (image.kind !== 'executable' && image.kind !== 'pie-executable') throw new Error(`Unicorn Linux process backend requires an executable ELF; got ${image.kind}.`);
    assertPreparedLinuxRuntimeEnvironmentMatches(file, image, environment);
    if (!environment.symbolVersions.compatible) throw new Error('Prepared Linux runtime environment contains unsatisfied GNU symbol versions.');

    this.engine = new unicorn.Unicorn(unicorn.ARCH_X86, unicorn.MODE_64);
    this.decoder = createX86_64InstructionDecoder(capstone);
    this.stdinBytes = new TextEncoder().encode(policy.stdin);

    try {
      const entry = this.prepareProcess();
      this.installHooks();
      this.engine.reg_write_i64(this.unicorn.X86_REG_RIP, BigInt(entry));
      appendEvent(this.eventsValue, {
        kind: 'prepared',
        message: `Loaded ${file.name} with Unicorn/WASM Linux userspace: PT_INTERP + ${environment.closure.modules.length} materialized runtime module(s), no kernel.`
      });
    } catch (error) {
      this.decoder.close();
      this.engine.close();
      throw error;
    }
  }

  static async create(
    file: ProjectFile,
    image: LoadedImage,
    environment: PreparedLinuxRuntimeEnvironment,
    policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
  ): Promise<UnicornLinuxProcessSession> {
    const [unicorn, capstone] = await Promise.all([loadUnicornX86(), loadCapstone()]);
    return new UnicornLinuxProcessSession(file, image, environment, unicorn, capstone, policy);
  }

  static createWithModules(
    file: ProjectFile,
    image: LoadedImage,
    environment: PreparedLinuxRuntimeEnvironment,
    unicorn: UnicornModule,
    capstone: CapstoneModule,
    policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
  ): UnicornLinuxProcessSession {
    return new UnicornLinuxProcessSession(file, image, environment, unicorn, capstone, policy);
  }

  get status(): ExecutionStatus { return this.statusValue; }

  private reservePage(page: number): void {
    if (this.mappedPages.has(page)) return;
    if (this.mappedBytesValue + PAGE_SIZE > this.policy.maxMappedBytes) {
      throw new Error(`Unicorn Linux mapping budget exceeded: ${this.mappedBytesValue + PAGE_SIZE} bytes > ${this.policy.maxMappedBytes}.`);
    }
    this.engine.mem_map(page, PAGE_SIZE, this.unicorn.PROT_ALL);
    this.mappedPages.add(page);
    this.mappedBytesValue += PAGE_SIZE;
  }

  private discardAnonymousRange(start: number, end: number): void {
    const next: AnonymousMapping[] = [];
    for (const mapping of this.anonymousMappings) {
      const mappingEnd = mapping.address + mapping.size;
      if (mappingEnd <= start || mapping.address >= end) {
        next.push(mapping);
        continue;
      }
      if (mapping.address < start) next.push({ ...mapping, size: start - mapping.address });
      if (mappingEnd > end) next.push({ ...mapping, address: end, size: mappingEnd - end });
    }
    this.anonymousMappings = next;
  }

  private rangeIsMapped(address: number, size: number): boolean {
    const start = alignDown(address, PAGE_SIZE);
    const end = alignUp(address + size, PAGE_SIZE);
    for (let page = start; page < end; page += PAGE_SIZE) if (!this.mappedPages.has(page)) return false;
    return true;
  }

  private rangeIsFree(address: number, size: number): boolean {
    const start = alignDown(address, PAGE_SIZE);
    const end = alignUp(address + size, PAGE_SIZE);
    for (let page = start; page < end; page += PAGE_SIZE) if (this.mappedPages.has(page)) return false;
    return true;
  }

  private findFreeMmapRange(size: number): number {
    let address = alignUp(this.mmapCursorValue, PAGE_SIZE);
    for (;;) {
      let collision: number | null = null;
      for (let page = address; page < address + size; page += PAGE_SIZE) {
        if (this.mappedPages.has(page)) { collision = page; break; }
      }
      if (collision === null) return address;
      address = collision + PAGE_SIZE;
      if (!Number.isSafeInteger(address + size)) throw new Error('Unicorn Linux mmap address space exceeded the browser-safe integer range.');
    }
  }

  private mapRange(address: number, size: number, replace = false): void {
    const start = alignDown(address, PAGE_SIZE);
    const end = alignUp(address + size, PAGE_SIZE);
    if (replace) this.discardAnonymousRange(start, end);
    for (let page = start; page < end; page += PAGE_SIZE) {
      if (replace && this.mappedPages.has(page)) {
        this.engine.mem_unmap(page, PAGE_SIZE);
        this.mappedPages.delete(page);
        this.mappedBytesValue -= PAGE_SIZE;
      }
      this.reservePage(page);
    }
  }

  private protectRange(address: number, size: number, permissions: number): void {
    const start = alignDown(address, PAGE_SIZE);
    const end = alignUp(address + size, PAGE_SIZE);
    for (let page = start; page < end; page += PAGE_SIZE) {
      if (this.mappedPages.has(page)) this.engine.mem_protect(page, PAGE_SIZE, permissions);
    }
  }

  private unmapRange(address: number, size: number): void {
    const start = alignDown(address, PAGE_SIZE);
    const end = alignUp(address + size, PAGE_SIZE);
    for (let page = start; page < end; page += PAGE_SIZE) {
      if (!this.mappedPages.has(page)) continue;
      this.engine.mem_unmap(page, PAGE_SIZE);
      this.mappedPages.delete(page);
      this.mappedBytesValue = Math.max(0, this.mappedBytesValue - PAGE_SIZE);
    }
    this.discardAnonymousRange(start, end);
    this.fileMappings = this.fileMappings.filter((mapping) => mapping.address + mapping.size <= start || mapping.address >= end);
  }

  private mapElf(file: VirtualFile, image: LoadedImage, loadBias: number): void {
    const pagePermissions = new Map<number, number>();
    for (let index = 0; index < image.segments.length; index += 1) {
      const segment = image.segments[index];
      if (segment.memorySize <= 0) continue;
      const start = alignDown(loadBias + segment.virtualAddress, PAGE_SIZE);
      const end = alignUp(loadBias + segment.virtualAddress + segment.memorySize, PAGE_SIZE);
      const permissions = segmentPermissions(this.unicorn, image, index);
      for (let page = start; page < end; page += PAGE_SIZE) pagePermissions.set(page, (pagePermissions.get(page) ?? 0) | permissions);
    }
    for (const page of pagePermissions.keys()) this.reservePage(page);
    for (const segment of image.segments) {
      if (segment.fileSize <= 0) continue;
      const end = segment.offset + segment.fileSize;
      if (segment.offset < 0 || end > file.bytes.byteLength) throw new Error(`${file.name} PT_LOAD #${segment.index} exceeds its file bytes.`);
      this.engine.mem_write(loadBias + segment.virtualAddress, file.bytes.subarray(segment.offset, end));
    }
    for (const [page, permissions] of pagePermissions) this.engine.mem_protect(page, PAGE_SIZE, permissions);
    for (const segment of image.segments) {
      if (segment.memorySize <= 0) continue;
      this.runtimeMappings.push({
        file,
        runtimeStart: loadBias + segment.virtualAddress,
        runtimeEnd: loadBias + segment.virtualAddress + segment.memorySize,
        imageStart: segment.virtualAddress,
        loadBias
      });
    }
  }

  private registerFile(path: string, file: VirtualFile): void {
    this.filesByPath.set(normalizePath(path), file);
  }

  private installVirtualFiles(programFile: VirtualFile): VirtualFile | null {
    this.registerFile(this.image.sourcePath, programFile);
    this.registerFile(`/${this.file.name}`, programFile);
    this.registerFile('/proc/self/exe', programFile);

    const interpreterName = this.image.interpreter ? basename(this.image.interpreter) : null;
    let interpreter: VirtualFile | null = null;
    for (const module of this.environment.closure.modules) {
      const isInterpreter = !!interpreterName && (module.requestedName === interpreterName || module.fileName === interpreterName || module.soname === interpreterName);
      const virtual = virtualFileFromModule(module, isInterpreter ? 'interpreter' : 'dependency');
      const names = new Set([module.requestedName, module.fileName, module.soname].filter((value): value is string => !!value));
      for (const name of names) {
        this.registerFile(`/${name}`, virtual);
        this.registerFile(`/lib/${name}`, virtual);
        this.registerFile(`/lib64/${name}`, virtual);
        this.registerFile(`/lib/x86_64-linux-gnu/${name}`, virtual);
        this.registerFile(`/usr/lib/${name}`, virtual);
        this.registerFile(`/usr/lib/x86_64-linux-gnu/${name}`, virtual);
      }
      if (isInterpreter) interpreter = virtual;
    }
    if (this.image.interpreter && interpreter) this.registerFile(this.image.interpreter, interpreter);
    return interpreter;
  }

  private prepareProcess(): number {
    const programFile: VirtualFile = {
      path: this.image.sourcePath,
      name: this.file.name,
      bytes: new Uint8Array(this.file.bytes!),
      role: 'program',
      image: this.image
    };
    const interpreterFile = this.installVirtualFiles(programFile);
    const programBias = this.image.kind === 'pie-executable' ? chooseLoadBias(this.image, PIE_BASE) : 0;
    this.mapElf(programFile, this.image, programBias);

    const stackBytes = alignUp(Math.max(PAGE_SIZE, this.policy.stackBytes), PAGE_SIZE);
    const stackBase = STACK_TOP - stackBytes;
    this.mapRange(stackBase, stackBytes);
    this.protectRange(stackBase, stackBytes, this.unicorn.PROT_READ | this.unicorn.PROT_WRITE);

    let interpreterBias = 0;
    let processEntry = programBias + this.image.entry;
    if (this.image.interpreter) {
      if (!interpreterFile?.image) throw new Error(`PT_INTERP ${this.image.interpreter} is not available as a valid ELF64 x86-64 Global Dependency.`);
      interpreterBias = chooseLoadBias(interpreterFile.image, INTERPRETER_BASE);
      this.mapElf(interpreterFile, interpreterFile.image, interpreterBias);
      processEntry = interpreterBias + interpreterFile.image.entry;
    }

    const programEnd = Math.max(...this.image.segments.map((segment) => programBias + segment.virtualAddress + segment.memorySize));
    this.heapBaseValue = alignUp(programEnd, PAGE_SIZE);
    this.programBreakValue = this.heapBaseValue;
    this.mmapCursorValue = MMAP_BASE;
    this.initializeStack(stackBase, programBias, interpreterBias);
    return processEntry;
  }

  private initializeStack(stackBase: number, programBias: number, interpreterBias: number): void {
    const encoder = new TextEncoder();
    let cursor = STACK_TOP;
    const pushString = (value: string): number => {
      const bytes = encoder.encode(`${value}\0`);
      cursor -= bytes.byteLength;
      if (cursor < stackBase) throw new Error('Configured Unicorn stack is too small for Linux process strings.');
      this.engine.mem_write(cursor, bytes);
      return cursor;
    };

    const execfn = pushString(this.image.sourcePath || `/${this.file.name}`);
    const platform = pushString('x86_64');
    const randomBytes = new Uint8Array(16);
    for (let index = 0; index < randomBytes.length; index += 1) randomBytes[index] = (0x5a + index * 17) & 0xff;
    cursor -= randomBytes.byteLength;
    const randomAddress = cursor;
    this.engine.mem_write(randomAddress, randomBytes);
    cursor = alignDown(cursor, 16);

    const header = parseKernelHeader(this.file.bytes!, this.image, programBias);
    const auxv: Array<[number, number]> = [
      [3, header.phdrAddress],
      [4, header.phentsize],
      [5, header.phnum],
      [6, PAGE_SIZE],
      [7, interpreterBias],
      [8, 0],
      [9, programBias + this.image.entry],
      [11, 1000], [12, 1000], [13, 1000], [14, 1000],
      [16, 0],
      [17, 100],
      [23, 0],
      [25, randomAddress],
      [26, 0],
      [31, execfn],
      [15, platform],
      [0, 0]
    ];

    const words: bigint[] = [1n, BigInt(execfn), 0n, 0n];
    for (const [type, value] of auxv) words.push(BigInt(type), BigInt(value));
    let rsp = alignDown(cursor - words.length * 8, 16);
    if (rsp < stackBase) throw new Error('Configured Unicorn stack is too small for the Linux initial stack.');
    for (let index = 0; index < words.length; index += 1) writeU64(this.engine, rsp + index * 8, words[index]);
    this.engine.reg_write_i64(this.unicorn.X86_REG_RSP, BigInt(rsp));
    this.engine.reg_write_i64(this.unicorn.X86_REG_RDX, 0n);
  }

  private installHooks(): void {
    this.codeHook = this.engine.hook_add(this.unicorn.HOOK_CODE, (...args: unknown[]) => {
      const addressValue = args[1];
      const sizeValue = args[2];
      const address = typeof addressValue === 'bigint' ? addressValue : BigInt(Number(addressValue));
      this.onInstruction(address, Number(sizeValue));
    });
  }

  private runtimeImageAt(address: number): { snapshot: ExecutionRuntimeImageSnapshot; mapping: RuntimeImageMapping } | null {
    for (const mapping of this.runtimeMappings) {
      if (address < mapping.runtimeStart || address >= mapping.runtimeEnd) continue;
      const imageAddress = mapping.imageStart + (address - mapping.runtimeStart);
      return {
        mapping,
        snapshot: {
          name: mapping.file.name,
          role: mapping.file.role,
          runtimeAddress: BigInt(address),
          imageAddress: BigInt(imageAddress),
          loadBias: BigInt(mapping.loadBias),
          confidence: mapping.loadBias === 0 ? 'fixed-address' : 'known-load-bias',
          signatureBytes: 0
        }
      };
    }

    for (const region of this.fileMappings) {
      if (address < region.address || address >= region.address + region.size || !region.file.image) continue;
      const fileOffset = region.fileOffset + (address - region.address);
      const segment = region.file.image.segments.find((candidate) => fileOffset >= candidate.offset && fileOffset < candidate.offset + candidate.fileSize);
      if (!segment) continue;
      const imageAddress = segment.virtualAddress + (fileOffset - segment.offset);
      const loadBias = address - imageAddress;
      return {
        mapping: {
          file: region.file,
          runtimeStart: region.address,
          runtimeEnd: region.address + region.size,
          imageStart: imageAddress - (address - region.address),
          loadBias
        },
        snapshot: {
          name: region.file.name,
          role: region.file.role,
          runtimeAddress: BigInt(address),
          imageAddress: BigInt(imageAddress),
          loadBias: BigInt(loadBias),
          confidence: 'known-load-bias',
          signatureBytes: 0
        }
      };
    }
    return null;
  }

  private onInstruction(runtimeAddress: bigint, _reportedSize: number): void {
    if (terminal(this.statusValue)) { this.engine.emu_stop(); return; }
    if (this.instructionCountValue >= this.policy.maxInstructions) {
      this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
      this.engine.emu_stop();
      return;
    }
    try {
      const address = safeNumber(runtimeAddress, 'Unicorn RIP');
      const bytes = instructionBytes(this.engine, runtimeAddress);
      const decoded = this.decoder.decodeOne(bytes, address);
      if (!decoded) throw new Error(`Capstone could not decode Unicorn instruction at 0x${address.toString(16)}.`);
      const runtimeImage = this.runtimeImageAt(address);
      const role = runtimeImage?.snapshot.role ?? null;
      const canonicalAddress = runtimeImage?.snapshot.role === 'program' ? Number(runtimeImage.snapshot.imageAddress) : address;
      const canonicalEnd = canonicalAddress + decoded.size;
      this.lastInstructionValue = { address: canonicalAddress, endAddress: canonicalEnd, mnemonic: decoded.mnemonic, operands: decoded.operands };
      this.runtimeDisassemblyValue = {
        source: 'unicorn-runtime',
        lines: [`0x${address.toString(16)}  ${decoded.mnemonic}${decoded.operands ? ` ${decoded.operands}` : ''}`],
        currentLine: 0,
        image: runtimeImage?.snapshot ?? null
      };
      this.instructionCountValue += 1;

      if (role === 'program') {
        if (this.lastInstructionRole !== 'program') appendEvent(this.eventsValue, { kind: 'trace-gap', reason: 'non-program-image' });
        appendEvent(this.eventsValue, { kind: 'instruction', address: canonicalAddress, mnemonic: decoded.mnemonic, operands: decoded.operands });
      } else if (this.lastInstructionRole === 'program') {
        appendEvent(this.eventsValue, { kind: 'trace-gap', reason: role ? 'non-program-image' : 'runtime-image-unresolved' });
      }
      this.lastInstructionRole = role;

      if (decoded.controlFlow === 'syscall' || decoded.mnemonic.toLowerCase() === 'syscall') {
        this.virtualSyscall(runtimeAddress, BigInt(decoded.endAddress));
        this.engine.emu_stop();
      }
    } catch (error) {
      this.trap(error instanceof Error ? error.message : String(error));
      this.engine.emu_stop();
    }
  }

  private setSyscallResult(value: bigint | number): void {
    this.engine.reg_write_i64(this.unicorn.X86_REG_RAX, BigInt.asUintN(64, BigInt(value)));
  }

  private failSyscall(errno: number): void { this.setSyscallResult(-errno); }

  private recordSyscall(number: number, name: string, detail: string): void {
    appendEvent(this.eventsValue, { kind: 'syscall', number, name, detail });
  }

  private readCString(address: bigint): string {
    const base = safeNumber(address, 'guest string address');
    const bytes = this.engine.mem_read(base, MAX_PATH_BYTES);
    const zero = bytes.indexOf(0);
    return new TextDecoder().decode(zero >= 0 ? bytes.subarray(0, zero) : bytes);
  }

  private resolveFile(path: string): VirtualFile | null {
    const normalized = normalizePath(path);
    const exact = this.filesByPath.get(normalized);
    if (exact) return exact;
    const name = basename(normalized);
    for (const [candidate, file] of this.filesByPath) if (basename(candidate) === name) return file;
    return null;
  }

  private openVirtual(path: string): number {
    const file = this.resolveFile(path);
    if (!file) return -ENOENT;
    const fd = this.nextFdValue++;
    this.openFiles.set(fd, { file, position: 0 });
    return fd;
  }

  private writeStat(address: number, file: VirtualFile): void {
    const bytes = new Uint8Array(144);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 1n, true);
    view.setBigUint64(8, 1n, true);
    view.setBigUint64(16, 1n, true);
    view.setUint32(24, 0o100555, true);
    view.setUint32(28, 1000, true);
    view.setUint32(32, 1000, true);
    view.setBigUint64(48, BigInt(file.bytes.byteLength), true);
    view.setBigUint64(56, 4096n, true);
    view.setBigUint64(64, BigInt(Math.ceil(file.bytes.byteLength / 512)), true);
    this.engine.mem_write(address, bytes);
  }

  private copyFileBytes(fd: number, address: bigint, count: number, offset: number | null): number {
    const opened = this.openFiles.get(fd);
    if (!opened) return -EBADF;
    const position = offset ?? opened.position;
    const available = Math.max(0, Math.min(count, opened.file.bytes.byteLength - position));
    if (available > 0) this.engine.mem_write(address, opened.file.bytes.subarray(position, position + available));
    if (offset === null) opened.position += available;
    return available;
  }

  private appendTerminalBytes(fd: number, bytes: Uint8Array): number {
    if (fd !== 1 && fd !== 2) return -EBADF;
    if (!bytes.byteLength) return 0;
    const text = new TextDecoder().decode(bytes);
    if (fd === 1) {
      this.stdoutValue += text;
      appendEvent(this.eventsValue, { kind: 'stdout', text });
    } else {
      this.stderrValue += text;
      appendEvent(this.eventsValue, { kind: 'stderr', text });
    }
    return bytes.byteLength;
  }

  private writeGuestBytes(fd: number, address: bigint, count: number): number {
    if (count > MAX_IO_BYTES) throw new Error(`write count ${count} exceeds the execution IO limit.`);
    if (fd !== 1 && fd !== 2) return -EBADF;
    return this.appendTerminalBytes(fd, this.engine.mem_read(address, count));
  }

  private syscallWritev(number: number): void {
    const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
    const vectorAddress = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'writev iovec address');
    const vectorCount = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX));
    if (vectorCount < 0 || vectorCount > MAX_IOV_COUNT) {
      this.failSyscall(EINVAL);
      this.recordSyscall(number, 'writev', `fd=${fd}, iovcnt=${vectorCount} -> -${EINVAL}`);
      return;
    }
    if (fd !== 1 && fd !== 2) {
      this.failSyscall(EBADF);
      this.recordSyscall(number, 'writev', `fd=${fd}, iovcnt=${vectorCount} -> -${EBADF}`);
      return;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let index = 0; index < vectorCount; index += 1) {
      const entryAddress = vectorAddress + index * IOVEC_SIZE;
      if (!Number.isSafeInteger(entryAddress)) throw new Error(`writev iovec[${index}] address is outside the browser-safe integer range.`);
      const entry = this.engine.mem_read(entryAddress, IOVEC_SIZE);
      const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
      const address = view.getBigUint64(0, true);
      const count = safeNumber(view.getBigUint64(8, true), `writev iovec[${index}] length`);
      if (count > MAX_IO_BYTES - total) throw new Error(`writev total ${total + count} exceeds the execution IO limit.`);
      if (count > 0) chunks.push(this.engine.mem_read(address, count));
      total += count;
    }

    const bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    this.setSyscallResult(this.appendTerminalBytes(fd, bytes));
    this.recordSyscall(number, 'writev', `fd=${fd}, iovcnt=${vectorCount}, count=${total}`);
  }

  private syscallMmap(number: number): void {
    const requestedAddress = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'mmap address');
    const length = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'mmap length');
    const protection = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX));
    const flags = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_R10));
    const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_R8));
    const fileOffset = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_R9), 'mmap file offset');
    if (length <= 0) { this.failSyscall(EINVAL); return; }
    const size = alignUp(length, PAGE_SIZE);
    const fixed = (flags & (MAP_FIXED | MAP_FIXED_NOREPLACE)) !== 0;
    const address = fixed && requestedAddress ? alignDown(requestedAddress, PAGE_SIZE) : alignUp(this.mmapCursorValue, PAGE_SIZE);
    const permissions = linuxProtection(this.unicorn, protection);
    this.mapRange(address, size, fixed);

    if ((flags & MAP_ANONYMOUS) === 0) {
      const opened = this.openFiles.get(fd);
      if (!opened) { this.unmapRange(address, size); this.failSyscall(EBADF); return; }
      const available = Math.max(0, Math.min(length, opened.file.bytes.byteLength - fileOffset));
      if (available > 0) this.engine.mem_write(address, opened.file.bytes.subarray(fileOffset, fileOffset + available));
      this.fileMappings.push({ file: opened.file, address, size, fileOffset });
    } else {
      this.anonymousMappings.push({ address, size, permissions });
    }
    this.protectRange(address, size, permissions);
    if (!fixed) this.mmapCursorValue = address + size + PAGE_SIZE;
    this.setSyscallResult(address);
    this.recordSyscall(number, 'mmap', `address=0x${address.toString(16)}, length=${length}, fd=${fd}, offset=${fileOffset}`);
  }

  private syscallMremap(number: number): void {
    const oldAddress = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'mremap old address');
    const oldLength = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'mremap old length');
    const newLength = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'mremap new length');
    const flags = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_R10));

    if (oldAddress % PAGE_SIZE !== 0 || oldLength <= 0 || newLength <= 0) {
      this.failSyscall(EINVAL);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> -${EINVAL}`);
      return;
    }
    if ((flags & ~MREMAP_MAYMOVE) !== 0) {
      this.failSyscall(ENOSYS);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)}${flags & MREMAP_FIXED ? ' (MREMAP_FIXED unsupported)' : ''} -> -${ENOSYS}`);
      return;
    }

    const oldSize = alignUp(oldLength, PAGE_SIZE);
    const newSize = alignUp(newLength, PAGE_SIZE);
    const mapping = this.anonymousMappings.find((candidate) => candidate.address === oldAddress && candidate.size === oldSize);
    if (!mapping) {
      const errno = this.rangeIsMapped(oldAddress, oldSize) ? ENOSYS : EFAULT;
      this.failSyscall(errno);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> -${errno} (${errno === ENOSYS ? 'non-anonymous or partial mapping unsupported' : 'source unmapped'})`);
      return;
    }

    if (newSize === oldSize) {
      this.setSyscallResult(oldAddress);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> 0x${oldAddress.toString(16)}`);
      return;
    }

    if (newSize < oldSize) {
      this.unmapRange(oldAddress + newSize, oldSize - newSize);
      this.setSyscallResult(oldAddress);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> 0x${oldAddress.toString(16)} (shrunk in place)`);
      return;
    }

    const extensionAddress = oldAddress + oldSize;
    const extensionSize = newSize - oldSize;
    if (this.rangeIsFree(extensionAddress, extensionSize)) {
      if (this.mappedBytesValue + extensionSize > this.policy.maxMappedBytes) {
        this.failSyscall(ENOMEM);
        this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> -${ENOMEM} (mapping budget)`);
        return;
      }
      this.mapRange(extensionAddress, extensionSize);
      this.protectRange(extensionAddress, extensionSize, mapping.permissions);
      mapping.size = newSize;
      this.setSyscallResult(oldAddress);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> 0x${oldAddress.toString(16)} (grown in place)`);
      return;
    }

    if ((flags & MREMAP_MAYMOVE) === 0) {
      this.failSyscall(ENOMEM);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> -${ENOMEM} (in-place growth blocked)`);
      return;
    }
    if (this.mappedBytesValue + newSize > this.policy.maxMappedBytes) {
      this.failSyscall(ENOMEM);
      this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> -${ENOMEM} (move would exceed mapping budget)`);
      return;
    }

    const copied = this.engine.mem_read(oldAddress, Math.min(oldSize, newSize));
    const newAddress = this.findFreeMmapRange(newSize);
    this.mapRange(newAddress, newSize);
    if (copied.byteLength) this.engine.mem_write(newAddress, copied);
    this.protectRange(newAddress, newSize, mapping.permissions);
    this.unmapRange(oldAddress, oldSize);
    this.anonymousMappings.push({ address: newAddress, size: newSize, permissions: mapping.permissions });
    this.mmapCursorValue = newAddress + newSize + PAGE_SIZE;
    this.setSyscallResult(newAddress);
    this.recordSyscall(number, 'mremap', `old=0x${oldAddress.toString(16)}, old_size=${oldLength}, new_size=${newLength}, flags=0x${flags.toString(16)} -> 0x${newAddress.toString(16)} (moved)`);
  }

  private syscallBrk(number: number): void {
    const requested = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'brk address');
    if (!requested) { this.setSyscallResult(this.programBreakValue); return; }
    if (requested < this.heapBaseValue) { this.setSyscallResult(this.programBreakValue); return; }
    const oldEnd = alignUp(this.programBreakValue, PAGE_SIZE);
    const newEnd = alignUp(requested, PAGE_SIZE);
    if (newEnd > oldEnd) {
      this.mapRange(oldEnd, newEnd - oldEnd);
      this.protectRange(oldEnd, newEnd - oldEnd, this.unicorn.PROT_READ | this.unicorn.PROT_WRITE);
    } else if (newEnd < oldEnd) this.unmapRange(newEnd, oldEnd - newEnd);
    this.programBreakValue = requested;
    this.setSyscallResult(requested);
    this.recordSyscall(number, 'brk', `value=0x${requested.toString(16)}`);
  }

  private syscallArchPrctl(number: number): void {
    const operation = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
    const address = this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
    if (operation === ARCH_SET_FS) this.engine.reg_write_i64(this.unicorn.X86_REG_FS_BASE, address);
    else if (operation === ARCH_SET_GS) this.engine.reg_write_i64(this.unicorn.X86_REG_GS_BASE, address);
    else if (operation === ARCH_GET_FS) writeU64(this.engine, safeNumber(address, 'ARCH_GET_FS output'), this.engine.reg_read_i64(this.unicorn.X86_REG_FS_BASE));
    else if (operation === ARCH_GET_GS) writeU64(this.engine, safeNumber(address, 'ARCH_GET_GS output'), this.engine.reg_read_i64(this.unicorn.X86_REG_GS_BASE));
    else { this.failSyscall(EINVAL); return; }
    this.setSyscallResult(0);
    this.recordSyscall(number, 'arch_prctl', `op=0x${operation.toString(16)}`);
  }

  private syscallFutex(number: number): void {
    const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'futex address');
    const operation = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI));
    const expected = Number(BigInt.asUintN(32, this.engine.reg_read_i64(this.unicorn.X86_REG_RDX)));
    const command = operation & FUTEX_CMD_MASK;

    if (command === FUTEX_WAIT) {
      const bytes = this.engine.mem_read(address, 4);
      const current = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      if (current !== expected) {
        this.failSyscall(EAGAIN);
        this.recordSyscall(number, 'futex', `WAIT op=0x${operation.toString(16)}, address=0x${address.toString(16)}, expected=${expected}, current=${current} -> -${EAGAIN}`);
        return;
      }
      this.recordSyscall(number, 'futex', `WAIT op=0x${operation.toString(16)}, address=0x${address.toString(16)}, expected=${expected}, current=${current} -> would-block`);
      this.trap(`Linux futex WAIT at 0x${address.toString(16)} would block in the single-thread Unicorn userspace contract (value ${current} matched expected ${expected}).`);
      return;
    }

    if (command === FUTEX_WAKE) {
      this.setSyscallResult(0);
      this.recordSyscall(number, 'futex', `WAKE op=0x${operation.toString(16)}, address=0x${address.toString(16)} -> 0 waiters`);
      return;
    }

    this.failSyscall(ENOSYS);
    this.recordSyscall(number, 'futex', `op=0x${operation.toString(16)} -> -${ENOSYS}`);
  }

  private virtualSyscall(syscallRip: bigint, nextRip: bigint): void {
    if (this.policy.syscallPolicy === 'none') { this.trap('Linux syscalls are disabled by execution policy.'); return; }
    const number = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RAX));
    this.engine.reg_write_i64(this.unicorn.X86_REG_RCX, nextRip);
    this.engine.reg_write_i64(this.unicorn.X86_REG_R11, this.engine.reg_read_i64(this.unicorn.X86_REG_RFLAGS));
    this.engine.reg_write_i64(this.unicorn.X86_REG_RIP, nextRip);

    try {
      if (number === SYS_EXIT || number === SYS_EXIT_GROUP) {
        const code = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI) & 0xffn);
        this.recordSyscall(number, number === SYS_EXIT ? 'exit' : 'exit_group', `code=${code}`);
        this.exitCodeValue = code;
        this.statusValue = 'exited';
        appendEvent(this.eventsValue, { kind: 'exit', code });
        return;
      }
      if (number === SYS_WRITE) {
        const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const address = this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
        const count = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'write count');
        const result = this.writeGuestBytes(fd, address, count);
        this.setSyscallResult(result);
        this.recordSyscall(number, 'write', `fd=${fd}, count=${count}${result < 0 ? ` -> ${result}` : ''}`);
        return;
      }
      if (number === SYS_WRITEV) { this.syscallWritev(number); return; }
      if (number === SYS_READ) {
        const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const address = this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
        const count = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'read count');
        if (count > MAX_IO_BYTES) throw new Error(`read count ${count} exceeds the execution IO limit.`);
        if (fd === 0) {
          const available = Math.max(0, Math.min(count, this.stdinBytes.length - this.stdinCursor));
          if (available > 0) {
            this.engine.mem_write(address, this.stdinBytes.subarray(this.stdinCursor, this.stdinCursor + available));
            this.stdinCursor += available;
          }
          this.setSyscallResult(available);
        } else this.setSyscallResult(this.copyFileBytes(fd, address, count, null));
        this.recordSyscall(number, 'read', `fd=${fd}, count=${count}`);
        return;
      }
      if (number === SYS_OPEN || number === SYS_OPENAT) {
        const pathAddress = number === SYS_OPEN ? this.engine.reg_read_i64(this.unicorn.X86_REG_RDI) : this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
        const path = this.readCString(pathAddress);
        const fd = this.openVirtual(path);
        this.setSyscallResult(fd);
        this.recordSyscall(number, number === SYS_OPEN ? 'open' : 'openat', `${path} -> ${fd}`);
        return;
      }
      if (number === SYS_ACCESS) {
        const path = this.readCString(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const mode = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI));
        if ((mode & ~0x7) !== 0) {
          this.failSyscall(EINVAL);
          this.recordSyscall(number, 'access', `${path}, mode=0x${mode.toString(16)} -> -${EINVAL}`);
          return;
        }
        const target = this.resolveFile(path);
        if (!target) {
          this.failSyscall(ENOENT);
          this.recordSyscall(number, 'access', `${path}, mode=0x${mode.toString(16)} -> -${ENOENT}`);
          return;
        }
        if ((mode & 0x2) !== 0) {
          this.failSyscall(EACCES);
          this.recordSyscall(number, 'access', `${path}, mode=0x${mode.toString(16)} -> -${EACCES}`);
          return;
        }
        this.setSyscallResult(0);
        this.recordSyscall(number, 'access', `${path}, mode=0x${mode.toString(16)} -> 0`);
        return;
      }
      if (number === SYS_CLOSE) {
        const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        if (fd <= 2) this.setSyscallResult(0);
        else if (this.openFiles.delete(fd)) this.setSyscallResult(0);
        else this.failSyscall(EBADF);
        this.recordSyscall(number, 'close', `fd=${fd}`);
        return;
      }
      if (number === SYS_PREAD64) {
        const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const address = this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
        const count = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'pread64 count');
        const offset = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_R10), 'pread64 offset');
        this.setSyscallResult(this.copyFileBytes(fd, address, count, offset));
        this.recordSyscall(number, 'pread64', `fd=${fd}, count=${count}, offset=${offset}`);
        return;
      }
      if (number === SYS_LSEEK) {
        const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const offset = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI));
        const whence = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX));
        const opened = this.openFiles.get(fd);
        if (!opened) { this.failSyscall(EBADF); return; }
        const next = whence === SEEK_SET ? offset : whence === SEEK_CUR ? opened.position + offset : whence === SEEK_END ? opened.file.bytes.byteLength + offset : -1;
        if (next < 0) { this.failSyscall(EINVAL); return; }
        opened.position = next;
        this.setSyscallResult(next);
        return;
      }
      if (number === SYS_FSTAT || number === SYS_STAT || number === SYS_NEWFSTATAT) {
        let target: VirtualFile | null = null;
        let outAddress = 0;
        if (number === SYS_FSTAT) {
          const fd = signedNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
          target = this.openFiles.get(fd)?.file ?? null;
          outAddress = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'fstat output');
        } else if (number === SYS_STAT) {
          target = this.resolveFile(this.readCString(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI)));
          outAddress = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'stat output');
        } else {
          target = this.resolveFile(this.readCString(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI)));
          outAddress = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'newfstatat output');
        }
        if (!target) { this.failSyscall(ENOENT); return; }
        this.writeStat(outAddress, target);
        this.setSyscallResult(0);
        this.recordSyscall(number, number === SYS_FSTAT ? 'fstat' : number === SYS_STAT ? 'stat' : 'newfstatat', target.path);
        return;
      }
      if (number === SYS_MMAP) { this.syscallMmap(number); return; }
      if (number === SYS_MREMAP) { this.syscallMremap(number); return; }
      if (number === SYS_MUNMAP) {
        const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'munmap address');
        const length = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'munmap length');
        this.unmapRange(address, length);
        this.setSyscallResult(0);
        return;
      }
      if (number === SYS_MPROTECT) {
        const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'mprotect address');
        const length = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'mprotect length');
        const protection = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX));
        this.protectRange(address, length, linuxProtection(this.unicorn, protection));
        this.setSyscallResult(0);
        return;
      }
      if (number === SYS_BRK) { this.syscallBrk(number); return; }
      if (number === SYS_ARCH_PRCTL) { this.syscallArchPrctl(number); return; }
      if (number === SYS_FUTEX) { this.syscallFutex(number); return; }
      if (number === SYS_CLOCK_GETTIME) {
        const clockId = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'clock_gettime output');
        const milliseconds = (clockId === 1 || clockId === 4 || clockId === 6) && typeof performance !== 'undefined' ? performance.now() : Date.now();
        writeTimespec(this.engine, address, milliseconds);
        this.setSyscallResult(0);
        return;
      }
      if (number === SYS_GETPID || number === SYS_GETTID || number === SYS_SET_TID_ADDRESS) {
        this.setSyscallResult(1);
        return;
      }
      if (number === SYS_GETUID || number === SYS_GETEUID || number === SYS_GETGID || number === SYS_GETEGID) {
        this.setSyscallResult(1000);
        return;
      }
      if (number === SYS_UNAME) {
        writeUtsName(this.engine, safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'uname output'));
        this.setSyscallResult(0);
        return;
      }
      if (number === SYS_GETCWD) {
        const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'getcwd output');
        const size = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'getcwd size');
        const bytes = new TextEncoder().encode('/\0');
        if (size < bytes.length) { this.failSyscall(EINVAL); return; }
        this.engine.mem_write(address, bytes);
        this.setSyscallResult(address);
        return;
      }
      if (number === SYS_READLINK || number === SYS_READLINKAT) {
        const pathAddress = number === SYS_READLINK ? this.engine.reg_read_i64(this.unicorn.X86_REG_RDI) : this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
        const outAddress = number === SYS_READLINK ? this.engine.reg_read_i64(this.unicorn.X86_REG_RSI) : this.engine.reg_read_i64(this.unicorn.X86_REG_RDX);
        const count = number === SYS_READLINK ? safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'readlink count') : safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_R10), 'readlinkat count');
        const path = this.readCString(pathAddress);
        if (normalizePath(path) !== '/proc/self/exe') { this.failSyscall(ENOENT); return; }
        const encoded = new TextEncoder().encode(this.image.sourcePath);
        const written = Math.min(count, encoded.length);
        if (written) this.engine.mem_write(outAddress, encoded.subarray(0, written));
        this.setSyscallResult(written);
        return;
      }
      if (number === SYS_GETRANDOM) {
        const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'getrandom buffer');
        const count = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'getrandom count');
        const bytes = new Uint8Array(count);
        for (let index = 0; index < count; index += 1) bytes[index] = (0xa5 + index * 29 + this.instructionCountValue) & 0xff;
        this.engine.mem_write(address, bytes);
        this.setSyscallResult(count);
        return;
      }
      if (number === SYS_PRLIMIT64) {
        const out = this.engine.reg_read_i64(this.unicorn.X86_REG_R10);
        if (out !== 0n) {
          const address = safeNumber(out, 'prlimit64 output');
          writeU64(this.engine, address, 0xffff_ffff_ffff_ffffn);
          writeU64(this.engine, address + 8, 0xffff_ffff_ffff_ffffn);
        }
        this.setSyscallResult(0);
        return;
      }
      if (number === SYS_RT_SIGACTION || number === SYS_RT_SIGPROCMASK || number === SYS_SET_ROBUST_LIST || number === SYS_MADVISE) {
        this.setSyscallResult(0);
        return;
      }
      if (number === SYS_IOCTL) { this.failSyscall(ENOTTY); return; }
      if (number === SYS_RSEQ) { this.failSyscall(ENOSYS); return; }

      const args = [
        ['rdi', this.engine.reg_read_i64(this.unicorn.X86_REG_RDI)],
        ['rsi', this.engine.reg_read_i64(this.unicorn.X86_REG_RSI)],
        ['rdx', this.engine.reg_read_i64(this.unicorn.X86_REG_RDX)],
        ['r10', this.engine.reg_read_i64(this.unicorn.X86_REG_R10)],
        ['r8', this.engine.reg_read_i64(this.unicorn.X86_REG_R8)],
        ['r9', this.engine.reg_read_i64(this.unicorn.X86_REG_R9)]
      ].map(([name, value]) => `${name}=0x${(value as bigint).toString(16)}`).join(', ');
      throw new Error(`Linux syscall ${number} at RIP 0x${syscallRip.toString(16)} is not implemented by the Unicorn Linux userspace contract (${args}).`);
    } catch (cause) {
      this.trap(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private trap(reason: string): void {
    if (this.statusValue === 'trapped') return;
    this.statusValue = 'trapped';
    this.trapReasonValue = reason;
    appendEvent(this.eventsValue, { kind: 'trap', reason });
  }

  private trapUnicorn(error: unknown): void {
    if (terminal(this.statusValue)) return;
    let errno: number | null = null;
    let description: string | null = null;
    try { errno = this.engine.errno(); description = this.unicorn.strerror(errno); } catch { /* preserve original */ }
    let rip: bigint | null = null;
    try { rip = this.engine.reg_read_i64(this.unicorn.X86_REG_RIP); } catch { /* closed/broken */ }
    const base = error instanceof Error ? error.message : String(error);
    const reason = `Unicorn Linux execution failed${rip !== null ? ` at RIP 0x${rip.toString(16)}` : ''}${errno !== null ? ` (errno ${errno}${description ? `: ${description}` : ''})` : ''}: ${base}`;
    this.providerDiagnosticsValue.push({ level: 'error', message: reason, count: 1 });
    this.trap(reason);
  }

  private runQuantum(count: number): void {
    if (count <= 0) return;
    const rip = this.engine.reg_read_i64(this.unicorn.X86_REG_RIP);
    try { this.engine.emu_start(rip, EMULATION_UNTIL, 0, count); }
    catch (error) { this.trapUnicorn(error); }
  }

  markRunning(): void {
    if (this.statusValue === 'ready' || this.statusValue === 'paused') this.statusValue = 'running';
  }

  pause(): void {
    if (this.statusValue === 'running') this.statusValue = 'paused';
  }

  step(): ExecutionSnapshot {
    if (terminal(this.statusValue)) return this.snapshot();
    this.statusValue = 'paused';
    this.runQuantum(1);
    const status = this.statusValue as ExecutionStatus;
    if (!terminal(status)) this.statusValue = 'paused';
    return this.snapshot();
  }

  runSlice(maxInstructions = 500): ExecutionSnapshot {
    this.markRunning();
    if (this.statusValue !== 'running') return this.snapshot();
    const remaining = this.policy.maxInstructions - this.instructionCountValue;
    if (remaining <= 0) { this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`); return this.snapshot(); }
    this.runQuantum(Math.max(1, Math.min(maxInstructions, remaining)));
    if (this.statusValue === 'running' && this.instructionCountValue >= this.policy.maxInstructions) this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
    return this.snapshot();
  }

  private registerSnapshot(): ExecutionRegisterSnapshot {
    const read = (id: number) => this.engine.reg_read_i64(id);
    return {
      rax: read(this.unicorn.X86_REG_RAX), rbx: read(this.unicorn.X86_REG_RBX),
      rcx: read(this.unicorn.X86_REG_RCX), rdx: read(this.unicorn.X86_REG_RDX),
      rsi: read(this.unicorn.X86_REG_RSI), rdi: read(this.unicorn.X86_REG_RDI),
      rbp: read(this.unicorn.X86_REG_RBP), rsp: read(this.unicorn.X86_REG_RSP),
      rip: read(this.unicorn.X86_REG_RIP), r8: read(this.unicorn.X86_REG_R8),
      r9: read(this.unicorn.X86_REG_R9), r10: read(this.unicorn.X86_REG_R10),
      r11: read(this.unicorn.X86_REG_R11), r12: read(this.unicorn.X86_REG_R12),
      r13: read(this.unicorn.X86_REG_R13), r14: read(this.unicorn.X86_REG_R14),
      r15: read(this.unicorn.X86_REG_R15), rflags: read(this.unicorn.X86_REG_RFLAGS)
    };
  }

  snapshot(): ExecutionSnapshot {
    return {
      status: this.statusValue,
      targetFileId: this.file.id,
      targetName: this.file.name,
      imageKind: this.image.kind,
      provider: 'unicorn-linux',
      instructionCount: this.instructionCountValue,
      registers: this.registerSnapshot(),
      lastInstruction: this.lastInstructionValue,
      runtimeDisassembly: this.runtimeDisassemblyValue,
      stdout: this.stdoutValue,
      stderr: this.stderrValue,
      exitCode: this.exitCodeValue,
      trapReason: this.trapReasonValue,
      crash: null,
      providerDiagnostics: this.providerDiagnosticsValue.slice(),
      events: this.eventsValue.slice()
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.codeHook) {
      try { this.engine.hook_del(this.codeHook); } catch { /* engine may already be terminal */ }
      this.codeHook = null;
    }
    this.decoder.close();
    this.engine.close();
  }
}
