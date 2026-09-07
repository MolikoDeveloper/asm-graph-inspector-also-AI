import type { CanonicalInstruction, LoadedImage } from '../binary/model';
import { createX86_64InstructionDecoder, type X86_64InstructionDecoder } from '../capstone/capstoneDecoder';
import { loadCapstone } from '../capstone/capstoneLoader';
import type { CapstoneModule } from '../capstone/types';
import type { ProjectFile } from '../project/model';
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionEvent,
  type ExecutionPolicy,
  type ExecutionProviderDiagnostic,
  type ExecutionRegisterSnapshot,
  type ExecutionSnapshot,
  type ExecutionStatus
} from './model';
import { loadUnicornX86 } from './unicornLoader';
import type { UnicornEngine, UnicornHook, UnicornModule } from './unicornTypes';

const PAGE_SIZE = 4096;
const STACK_TOP = 0x0000_7fff_ffff_f000;
const MMAP_BASE = 0x0000_6000_0000_0000;
const MAX_IO_BYTES = 1024 * 1024;
const MAX_X86_INSTRUCTION_BYTES = 15;
const EMULATION_UNTIL = 0xffff_ffff_ffff_ffffn;

const SYS_READ = 0;
const SYS_WRITE = 1;
const SYS_MMAP = 9;
const SYS_MPROTECT = 10;
const SYS_MUNMAP = 11;
const SYS_BRK = 12;
const SYS_GETPID = 39;
const SYS_UNAME = 63;
const SYS_ARCH_PRCTL = 158;
const SYS_GETTID = 186;
const SYS_CLOCK_GETTIME = 228;
const SYS_EXIT = 60;
const SYS_EXIT_GROUP = 231;

const MAP_FIXED = 0x10;
const MAP_ANONYMOUS = 0x20;
const ARCH_SET_GS = 0x1001;
const ARCH_SET_FS = 0x1002;
const ARCH_GET_FS = 0x1003;
const ARCH_GET_GS = 0x1004;

interface DynamicMapping {
  address: number;
  size: number;
  permissions: number;
  kind: 'brk' | 'mmap';
}

function appendEvent(events: ExecutionEvent[], event: ExecutionEvent): void {
  events.push(event);
  if (events.length > 300) events.splice(0, events.length - 300);
}

function alignDown(value: number, alignment: number): number {
  return Math.floor(value / alignment) * alignment;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is outside the browser-safe integer range.`);
  return number;
}

function terminal(status: ExecutionStatus): boolean {
  return status === 'exited' || status === 'halted' || status === 'trapped';
}

function segmentPermissions(module: UnicornModule, readable: boolean, writable: boolean, executable: boolean): number {
  return (readable ? module.PROT_READ : 0)
    | (writable ? module.PROT_WRITE : 0)
    | (executable ? module.PROT_EXEC : 0);
}

function linuxProtection(module: UnicornModule, protection: number): number {
  return (protection & 1 ? module.PROT_READ : 0)
    | (protection & 2 ? module.PROT_WRITE : 0)
    | (protection & 4 ? module.PROT_EXEC : 0);
}

function writeU64(engine: UnicornEngine, address: number, value: bigint): void {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
  engine.mem_write(address, bytes);
}

function writeTimespec(engine: UnicornEngine, address: number, milliseconds: number): void {
  const seconds = Math.floor(milliseconds / 1000);
  const nanoseconds = Math.floor((milliseconds - seconds * 1000) * 1_000_000);
  writeU64(engine, address, BigInt(seconds));
  writeU64(engine, address + 8, BigInt(nanoseconds));
}

function writeUtsName(engine: UnicornEngine, address: number): void {
  const fields = ['Linux', 'asm-graph', '6.0.0-browser', '#1 virtual userspace', 'x86_64', 'localdomain'];
  const bytes = new Uint8Array(65 * fields.length);
  const encoder = new TextEncoder();
  fields.forEach((field, index) => {
    const encoded = encoder.encode(field).subarray(0, 64);
    bytes.set(encoded, index * 65);
  });
  engine.mem_write(address, bytes);
}

function validateTarget(file: ProjectFile, image: LoadedImage): void {
  if (file.kind !== 'binary' || !file.bytes) throw new Error('Unicorn execution requires authoritative binary bytes.');
  if (image.architecture !== 'x86-64') throw new Error(`Unicorn x86 backend cannot execute architecture ${image.architecture}.`);
  if (image.kind !== 'executable') throw new Error(`Unicorn machine backend currently accepts fixed ET_EXEC images; image kind is ${image.kind}.`);
  if (image.interpreter || image.neededLibraries.length) throw new Error('Dynamic Linux ELF must use the process backend until Unicorn Linux userspace is implemented.');
  if (!image.segments.some((segment) => segment.executable && image.entry >= segment.virtualAddress && image.entry < segment.virtualAddress + segment.memorySize)) {
    throw new Error(`Entry point 0x${image.entry.toString(16)} is not inside an executable PT_LOAD mapping.`);
  }
}

export class UnicornMachineSession {
  private statusValue: ExecutionStatus = 'ready';
  private instructionCountValue = 0;
  private lastInstructionValue: CanonicalInstruction | null = null;
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
  private mappedBytesValue = 0;
  private heapBaseValue = 0;
  private programBreakValue = 0;
  private mmapCursorValue = MMAP_BASE;
  private dynamicMappings = new Map<number, DynamicMapping>();
  stdinBytes: Uint8Array;
  stdinCursor = 0;

  private constructor(
    readonly file: ProjectFile,
    readonly image: LoadedImage,
    private readonly unicorn: UnicornModule,
    capstone: CapstoneModule,
    readonly policy: ExecutionPolicy
  ) {
    validateTarget(file, image);
    this.engine = new unicorn.Unicorn(unicorn.ARCH_X86, unicorn.MODE_64);
    this.decoder = createX86_64InstructionDecoder(capstone);
    this.stdinBytes = new TextEncoder().encode(policy.stdin);

    try {
      this.mapImageAndStack();
      this.installHooks();
      this.engine.reg_write_i64(unicorn.X86_REG_RIP, BigInt(image.entry));
      appendEvent(this.eventsValue, {
        kind: 'prepared',
        message: `Loaded ${file.name} into Unicorn/WASM at fixed ELF virtual addresses; entry=0x${image.entry.toString(16)}; Linux userspace-lite is kernel-less.`
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
    policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
  ): Promise<UnicornMachineSession> {
    const [unicorn, capstone] = await Promise.all([loadUnicornX86(), loadCapstone()]);
    return new UnicornMachineSession(file, image, unicorn, capstone, policy);
  }

  /** Test/headless injection point: production code uses create() and the lazy same-origin loaders. */
  static createWithModules(
    file: ProjectFile,
    image: LoadedImage,
    unicorn: UnicornModule,
    capstone: CapstoneModule,
    policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
  ): UnicornMachineSession {
    return new UnicornMachineSession(file, image, unicorn, capstone, policy);
  }

  get status(): ExecutionStatus { return this.statusValue; }

  private mapImageAndStack(): void {
    const fileBytes = new Uint8Array(this.file.bytes!);
    const pagePermissions = new Map<number, number>();
    let programEnd = 0;

    for (const segment of this.image.segments) {
      if (segment.memorySize <= 0) continue;
      const start = alignDown(segment.virtualAddress, PAGE_SIZE);
      const end = alignUp(segment.virtualAddress + segment.memorySize, PAGE_SIZE);
      programEnd = Math.max(programEnd, segment.virtualAddress + segment.memorySize);
      const perms = segmentPermissions(this.unicorn, segment.readable, segment.writable, segment.executable);
      for (let page = start; page < end; page += PAGE_SIZE) {
        pagePermissions.set(page, (pagePermissions.get(page) ?? 0) | perms);
      }
    }

    const stackBytes = alignUp(Math.max(PAGE_SIZE, this.policy.stackBytes), PAGE_SIZE);
    const stackBase = STACK_TOP - stackBytes;
    for (let page = stackBase; page < STACK_TOP; page += PAGE_SIZE) {
      pagePermissions.set(page, this.unicorn.PROT_READ | this.unicorn.PROT_WRITE);
    }

    this.mappedBytesValue = pagePermissions.size * PAGE_SIZE;
    if (this.mappedBytesValue > this.policy.maxMappedBytes) {
      throw new Error(`Unicorn mapping budget exceeded: ${this.mappedBytesValue} bytes > ${this.policy.maxMappedBytes}.`);
    }

    const pages = [...pagePermissions.keys()].sort((a, b) => a - b);
    for (const page of pages) this.engine.mem_map(page, PAGE_SIZE, this.unicorn.PROT_ALL);

    for (const segment of this.image.segments) {
      if (segment.fileSize <= 0) continue;
      if (segment.offset < 0 || segment.offset + segment.fileSize > fileBytes.byteLength) {
        throw new Error(`PT_LOAD #${segment.index} file bytes are outside the ELF buffer.`);
      }
      this.engine.mem_write(
        segment.virtualAddress,
        fileBytes.subarray(segment.offset, segment.offset + segment.fileSize)
      );
    }

    for (const page of pages) this.engine.mem_protect(page, PAGE_SIZE, pagePermissions.get(page)!);
    this.heapBaseValue = alignUp(programEnd, PAGE_SIZE);
    this.programBreakValue = this.heapBaseValue;
    this.mmapCursorValue = Math.max(MMAP_BASE, alignUp(this.heapBaseValue + 16 * PAGE_SIZE, PAGE_SIZE));
    this.initializeStack(stackBase);
  }

  private initializeStack(stackBase: number): void {
    const argv0 = new TextEncoder().encode(`${this.image.sourcePath}\0`);
    let stringAddress = STACK_TOP - argv0.byteLength;
    if (stringAddress < stackBase) throw new Error('Configured Unicorn stack is too small for argv[0].');
    this.engine.mem_write(stringAddress, argv0);
    stringAddress = alignDown(stringAddress, 16);

    // argc, argv[0], argv terminator, envp terminator, minimal auxv.
    const words = [
      1n,
      BigInt(STACK_TOP - argv0.byteLength),
      0n,
      0n,
      6n, 4096n, // AT_PAGESZ
      9n, BigInt(this.image.entry), // AT_ENTRY
      0n, 0n // AT_NULL
    ];
    let rsp = alignDown(stringAddress - words.length * 8, 16);
    if (rsp < stackBase) throw new Error('Configured Unicorn stack is too small for the initial process stack.');
    for (let index = 0; index < words.length; index += 1) writeU64(this.engine, rsp + index * 8, words[index]);
    this.engine.reg_write_i64(this.unicorn.X86_REG_RSP, BigInt(rsp));
    this.engine.reg_write_i64(this.unicorn.X86_REG_RDX, 0n);
  }

  private installHooks(): void {
    this.codeHook = this.engine.hook_add(this.unicorn.HOOK_CODE, (...args: unknown[]) => {
      const addressValue = args[1];
      const sizeValue = args[2];
      const address = typeof addressValue === 'bigint' ? addressValue : BigInt(Number(addressValue));
      const size = Number(sizeValue);
      this.onInstruction(address, size);
    });
  }

  private onInstruction(runtimeAddress: bigint, size: number): void {
    if (terminal(this.statusValue)) {
      this.engine.emu_stop();
      return;
    }
    if (this.instructionCountValue >= this.policy.maxInstructions) {
      this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
      this.engine.emu_stop();
      return;
    }

    try {
      const address = safeNumber(runtimeAddress, 'Unicorn RIP');
      const byteCount = Math.max(1, Math.min(MAX_X86_INSTRUCTION_BYTES, Number.isFinite(size) ? size : MAX_X86_INSTRUCTION_BYTES));
      const bytes = this.engine.mem_read(runtimeAddress, byteCount);
      const instruction = this.decoder.decodeOne(bytes, address);
      if (!instruction) throw new Error(`Capstone could not decode Unicorn instruction at 0x${address.toString(16)}.`);
      this.lastInstructionValue = instruction;
      this.instructionCountValue += 1;
      appendEvent(this.eventsValue, {
        kind: 'instruction',
        address,
        mnemonic: instruction.mnemonic,
        operands: instruction.operands
      });

      // Unicorn is the CPU. Linux syscalls are the intentional userspace ABI
      // boundary: intercept before the guest instruction enters kernel state,
      // advance architectural RIP, apply the virtual syscall, and stop this
      // quantum so the browser/controller observes the new state.
      if (instruction.controlFlow === 'syscall' || instruction.mnemonic.toLowerCase() === 'syscall') {
        this.virtualSyscall(BigInt(instruction.endAddress));
        this.engine.emu_stop();
      }
    } catch (error) {
      this.trap(error instanceof Error ? error.message : String(error));
      this.engine.emu_stop();
    }
  }

  private setSyscallResult(value: bigint | number): void {
    this.engine.reg_write_i64(this.unicorn.X86_REG_RAX, BigInt(value));
  }

  private recordSyscall(number: number, name: string, detail: string): void {
    appendEvent(this.eventsValue, { kind: 'syscall', number, name, detail });
  }

  private reserveMapping(bytes: number): void {
    if (bytes < 0 || this.mappedBytesValue + bytes > this.policy.maxMappedBytes) {
      throw new Error(`Unicorn mapping budget exceeded: ${this.mappedBytesValue + bytes} bytes > ${this.policy.maxMappedBytes}.`);
    }
    this.mappedBytesValue += bytes;
  }

  private releaseMapping(bytes: number): void {
    this.mappedBytesValue = Math.max(0, this.mappedBytesValue - Math.max(0, bytes));
  }

  private syscallBrk(number: number): void {
    const requested = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'brk address');
    if (requested === 0) {
      this.setSyscallResult(this.programBreakValue);
      this.recordSyscall(number, 'brk', `query=0x${this.programBreakValue.toString(16)}`);
      return;
    }
    if (requested < this.heapBaseValue) {
      this.setSyscallResult(this.programBreakValue);
      this.recordSyscall(number, 'brk', `rejected=0x${requested.toString(16)}, current=0x${this.programBreakValue.toString(16)}`);
      return;
    }

    const oldEnd = alignUp(this.programBreakValue, PAGE_SIZE);
    const newEnd = alignUp(requested, PAGE_SIZE);
    if (newEnd > oldEnd) {
      const size = newEnd - oldEnd;
      this.reserveMapping(size);
      try {
        this.engine.mem_map(oldEnd, size, this.unicorn.PROT_READ | this.unicorn.PROT_WRITE);
        this.dynamicMappings.set(oldEnd, { address: oldEnd, size, permissions: this.unicorn.PROT_READ | this.unicorn.PROT_WRITE, kind: 'brk' });
      } catch (cause) {
        this.releaseMapping(size);
        throw cause;
      }
    } else if (newEnd < oldEnd) {
      const size = oldEnd - newEnd;
      this.engine.mem_unmap(newEnd, size);
      this.releaseMapping(size);
      for (const [base, mapping] of this.dynamicMappings) {
        if (mapping.kind === 'brk' && base >= newEnd) this.dynamicMappings.delete(base);
      }
    }
    this.programBreakValue = requested;
    this.setSyscallResult(requested);
    this.recordSyscall(number, 'brk', `value=0x${requested.toString(16)}`);
  }

  private syscallMmap(number: number): void {
    const requestedAddress = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'mmap address');
    const requestedLength = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'mmap length');
    const protection = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX));
    const flags = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_R10));
    const fd = this.engine.reg_read_i64(this.unicorn.X86_REG_R8);
    const offset = this.engine.reg_read_i64(this.unicorn.X86_REG_R9);
    if (requestedLength <= 0) throw new Error('mmap length must be greater than zero.');
    if ((flags & MAP_ANONYMOUS) === 0) throw new Error(`mmap currently accepts anonymous mappings only (flags=0x${flags.toString(16)}, fd=${fd}, offset=${offset}).`);
    if ((flags & MAP_FIXED) !== 0) throw new Error('mmap MAP_FIXED is not implemented by the Unicorn userspace-lite contract.');

    const size = alignUp(requestedLength, PAGE_SIZE);
    const address = alignUp(this.mmapCursorValue, PAGE_SIZE);
    const permissions = linuxProtection(this.unicorn, protection);
    this.reserveMapping(size);
    try {
      this.engine.mem_map(address, size, permissions);
    } catch (cause) {
      this.releaseMapping(size);
      throw cause;
    }
    this.dynamicMappings.set(address, { address, size, permissions, kind: 'mmap' });
    this.mmapCursorValue = address + size + PAGE_SIZE;
    this.setSyscallResult(address);
    this.recordSyscall(number, 'mmap', `hint=0x${requestedAddress.toString(16)}, returned=0x${address.toString(16)}, length=${requestedLength}, prot=0x${protection.toString(16)}, flags=0x${flags.toString(16)}`);
  }

  private syscallMunmap(number: number): void {
    const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'munmap address');
    const length = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'munmap length');
    if (length <= 0 || address % PAGE_SIZE !== 0) throw new Error('munmap requires a page-aligned address and non-zero length.');
    const size = alignUp(length, PAGE_SIZE);
    const mapping = this.dynamicMappings.get(address);
    if (!mapping || mapping.kind !== 'mmap' || mapping.size !== size) {
      throw new Error(`munmap currently requires an exact anonymous mmap region; 0x${address.toString(16)} + ${size} bytes was not found.`);
    }
    this.engine.mem_unmap(address, size);
    this.dynamicMappings.delete(address);
    this.releaseMapping(size);
    this.setSyscallResult(0);
    this.recordSyscall(number, 'munmap', `address=0x${address.toString(16)}, length=${length}`);
  }

  private syscallMprotect(number: number): void {
    const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'mprotect address');
    const length = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'mprotect length');
    const protection = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX));
    if (length <= 0 || address % PAGE_SIZE !== 0) throw new Error('mprotect requires a page-aligned address and non-zero length.');
    const size = alignUp(length, PAGE_SIZE);
    this.engine.mem_protect(address, size, linuxProtection(this.unicorn, protection));
    this.setSyscallResult(0);
    this.recordSyscall(number, 'mprotect', `address=0x${address.toString(16)}, length=${length}, prot=0x${protection.toString(16)}`);
  }

  private syscallArchPrctl(number: number): void {
    const operation = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
    const address = this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
    if (operation === ARCH_SET_FS) this.engine.reg_write_i64(this.unicorn.X86_REG_FS_BASE, address);
    else if (operation === ARCH_SET_GS) this.engine.reg_write_i64(this.unicorn.X86_REG_GS_BASE, address);
    else if (operation === ARCH_GET_FS) writeU64(this.engine, safeNumber(address, 'ARCH_GET_FS output'), this.engine.reg_read_i64(this.unicorn.X86_REG_FS_BASE));
    else if (operation === ARCH_GET_GS) writeU64(this.engine, safeNumber(address, 'ARCH_GET_GS output'), this.engine.reg_read_i64(this.unicorn.X86_REG_GS_BASE));
    else throw new Error(`arch_prctl operation 0x${operation.toString(16)} is not implemented.`);
    this.setSyscallResult(0);
    this.recordSyscall(number, 'arch_prctl', `op=0x${operation.toString(16)}, address=0x${address.toString(16)}`);
  }

  private syscallClockGettime(number: number): void {
    const clockId = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
    const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RSI), 'clock_gettime output');
    const monotonic = clockId === 1 || clockId === 4 || clockId === 6;
    const milliseconds = monotonic && typeof performance !== 'undefined' ? performance.now() : Date.now();
    writeTimespec(this.engine, address, milliseconds);
    this.setSyscallResult(0);
    this.recordSyscall(number, 'clock_gettime', `clock=${clockId}, address=0x${address.toString(16)}`);
  }

  private virtualSyscall(nextRip: bigint): void {
    if (this.policy.syscallPolicy === 'none') {
      this.trap('Linux syscalls are disabled by execution policy.');
      return;
    }

    const number = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RAX));
    if (!Number.isSafeInteger(number)) {
      this.trap('Syscall number is outside the supported integer range.');
      return;
    }

    // Model the architectural return state expected after Linux syscall.
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
        const fd = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const address = this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
        const count = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'write count');
        if (count > MAX_IO_BYTES) throw new Error(`write count ${count} exceeds the execution IO limit.`);
        if (fd !== 1 && fd !== 2) throw new Error(`write(fd=${fd}) is outside the virtual stdout/stderr contract.`);
        const text = new TextDecoder().decode(this.engine.mem_read(address, count));
        if (fd === 1) {
          this.stdoutValue += text;
          appendEvent(this.eventsValue, { kind: 'stdout', text });
        } else {
          this.stderrValue += text;
          appendEvent(this.eventsValue, { kind: 'stderr', text });
        }
        this.recordSyscall(number, 'write', `fd=${fd}, count=${count}`);
        this.setSyscallResult(count);
        return;
      }

      if (number === SYS_READ) {
        const fd = Number(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI));
        const address = this.engine.reg_read_i64(this.unicorn.X86_REG_RSI);
        const count = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDX), 'read count');
        if (fd !== 0) throw new Error(`read(fd=${fd}) is outside the virtual stdin contract.`);
        if (count > MAX_IO_BYTES) throw new Error(`read count ${count} exceeds the execution IO limit.`);
        const available = Math.max(0, Math.min(count, this.stdinBytes.length - this.stdinCursor));
        if (available > 0) {
          this.engine.mem_write(address, this.stdinBytes.subarray(this.stdinCursor, this.stdinCursor + available));
          this.stdinCursor += available;
        }
        this.recordSyscall(number, 'read', `fd=0, count=${count}, returned=${available}`);
        this.setSyscallResult(available);
        return;
      }

      if (number === SYS_BRK) { this.syscallBrk(number); return; }
      if (number === SYS_MMAP) { this.syscallMmap(number); return; }
      if (number === SYS_MUNMAP) { this.syscallMunmap(number); return; }
      if (number === SYS_MPROTECT) { this.syscallMprotect(number); return; }
      if (number === SYS_ARCH_PRCTL) { this.syscallArchPrctl(number); return; }
      if (number === SYS_CLOCK_GETTIME) { this.syscallClockGettime(number); return; }

      if (number === SYS_GETPID || number === SYS_GETTID) {
        this.setSyscallResult(1);
        this.recordSyscall(number, number === SYS_GETPID ? 'getpid' : 'gettid', 'virtual-id=1');
        return;
      }

      if (number === SYS_UNAME) {
        const address = safeNumber(this.engine.reg_read_i64(this.unicorn.X86_REG_RDI), 'uname output');
        writeUtsName(this.engine, address);
        this.setSyscallResult(0);
        this.recordSyscall(number, 'uname', `address=0x${address.toString(16)}`);
        return;
      }

      throw new Error(`Linux syscall ${number} is not implemented by the Unicorn userspace-lite contract.`);
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
    try {
      errno = this.engine.errno();
      description = this.unicorn.strerror(errno);
    } catch {
      // Preserve the original exception even if the wrapper cannot report errno.
    }
    let rip: bigint | null = null;
    try { rip = this.engine.reg_read_i64(this.unicorn.X86_REG_RIP); } catch { /* closed/broken engine */ }
    const base = error instanceof Error ? error.message : String(error);
    const reason = `Unicorn execution failed${rip !== null ? ` at RIP 0x${rip.toString(16)}` : ''}${errno !== null ? ` (errno ${errno}${description ? `: ${description}` : ''})` : ''}: ${base}`;
    this.providerDiagnosticsValue.push({ level: 'error', message: reason, count: 1 });
    this.trap(reason);
  }

  private runQuantum(count: number): void {
    if (count <= 0) return;
    const rip = this.engine.reg_read_i64(this.unicorn.X86_REG_RIP);
    try {
      this.engine.emu_start(rip, EMULATION_UNTIL, 0, count);
    } catch (error) {
      this.trapUnicorn(error);
    }
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
    // TypeScript cannot infer side effects performed from the Unicorn hook inside
    // emu_start(), so widen the post-quantum state deliberately before testing it.
    const postStatus = this.statusValue as ExecutionStatus;
    if (!terminal(postStatus)) {
      this.statusValue = 'paused';
      if (this.instructionCountValue >= this.policy.maxInstructions) this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
    }
    return this.snapshot();
  }

  runSlice(maxInstructions = 500): ExecutionSnapshot {
    this.markRunning();
    if (this.statusValue !== 'running') return this.snapshot();
    const remaining = this.policy.maxInstructions - this.instructionCountValue;
    if (remaining <= 0) {
      this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
      return this.snapshot();
    }
    this.runQuantum(Math.max(1, Math.min(maxInstructions, remaining)));
    if (this.statusValue === 'running' && this.instructionCountValue >= this.policy.maxInstructions) {
      this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
    }
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
      provider: 'unicorn-machine',
      instructionCount: this.instructionCountValue,
      registers: this.registerSnapshot(),
      lastInstruction: this.lastInstructionValue,
      runtimeDisassembly: null,
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
