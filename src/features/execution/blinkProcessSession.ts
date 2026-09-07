import type { LoadedImage } from '../binary/model';
import type { ProjectFile } from '../project/model';
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionEvent,
  type ExecutionInstructionSnapshot,
  type ExecutionPolicy,
  type ExecutionRegisterSnapshot,
  type ExecutionRuntimeDisassemblySnapshot,
  type ExecutionRuntimeImageSnapshot,
  type ExecutionSnapshot,
  type ExecutionStatus
} from './model';
import { materializeRuntimeDependencyClosure, type MaterializedRuntimeModule, type RuntimeDependencyClosure } from './runtimeDependencies';
import { describeExecutionError, ExecutionProviderDiagnosticBuffer } from './providerDiagnostics';
import { validateBlinkBuildProfile } from './blinkBuildProfile';
import { blinkRuntimeInstructionLine } from './runtimeDisassembly';
import {
  RuntimeImageResolver,
  runtimeImageCandidateFromElfBytes,
  runtimeImageCandidateFromLoadedImage,
  type RuntimeImageCandidate,
  type RuntimeImageRole
} from './runtimeImageResolver';

const SIGTRAP = 5;
const BLINK_PREEMPT = 40;
const BLINK_STEP = 41;
const BLINK_FAKE_TTY = 42;

// clstruct v1 indices from the pinned robalb/blink browser fork.
const CL = Object.freeze({
  version: 0,
  flags: 7,
  csBase: 8,
  rip: 9,
  rsp: 10,
  rbp: 11,
  rsi: 12,
  rdi: 13,
  r8: 14,
  r9: 15,
  r10: 16,
  r11: 17,
  r12: 18,
  r13: 19,
  r14: 20,
  r15: 21,
  rax: 22,
  rbx: 23,
  rcx: 24,
  rdx: 25,
  disMaxLines: 26,
  disMaxLineLen: 27,
  disCurrentLine: 28,
  disBuffer: 29
});

export interface BlinkFs {
  init(input: () => number | null, output: (byte: number) => void, error: (byte: number) => void): void;
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  chmod(path: string, mode: number): void;
  symlink(target: string, linkpath: string): void;
  unlink(path: string): void;
  analyzePath?(path: string): { exists?: boolean };
}

export interface BlinkModule {
  FS: BlinkFs;
  wasmExports: { memory: WebAssembly.Memory };
  addFunction(callback: (...args: number[]) => void, signature: string): number;
  callMain(args: string[]): void;
  _blinkenlib_get_clstruct(): number;
  _blinkenlib_get_argc_string(): number;
  _blinkenlib_get_argv_string(): number;
  _blinkenlib_get_progname_string(): number;
  _blinkenlib_run_fast(): void;
  _blinkenlib_starti(): void;
  _blinkenlib_stepi(): void;
  _blinkenlib_continue(): void;
  _blinkenlib_preempt_resume(): void;
  _blinkenlib_faketty_resume?(): void;
}

export type BlinkFactory = (options: Record<string, unknown>) => Promise<BlinkModule>;

export interface BlinkProcessRuntime {
  materialize(interpreterPath: string | null, directNeeded: string[]): Promise<RuntimeDependencyClosure>;
  loadFactory(): Promise<{ factory: BlinkFactory; wasmUrl: string }>;
}

const DEFAULT_BLINK_PROCESS_RUNTIME: BlinkProcessRuntime = Object.freeze({
  materialize: materializeRuntimeDependencyClosure,
  loadFactory: loadBlinkFactory
});

function appendEvent(events: ExecutionEvent[], event: ExecutionEvent): void {
  events.push(event);
  if (events.length > 300) events.splice(0, events.length - 300);
}

function terminal(status: ExecutionStatus): boolean {
  return status === 'exited' || status === 'halted' || status === 'trapped';
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function writeCString(memory: WebAssembly.Memory, address: number, value: string, maxLength: number): void {
  const encoded = new TextEncoder().encode(value);
  const length = Math.min(encoded.length, Math.max(0, maxLength - 1));
  const heap = new Uint8Array(memory.buffer);
  heap.set(encoded.subarray(0, length), address);
  heap[address + length] = 0;
}

async function loadBlinkFactory(): Promise<{ factory: BlinkFactory; wasmUrl: string }> {
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  const jsUrl = new URL('vendor/blink/blinkenlib.js', base).href;
  const wasmUrl = new URL('vendor/blink/blinkenlib.wasm', base).href;
  const profileUrl = new URL('vendor/blink/build-profile.json', base).href;
  try {
    const response = await fetch(profileUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Blink build profile request failed with HTTP ${response.status}.`);
    const validation = validateBlinkBuildProfile(await response.json());
    if (!validation.ok) throw new Error(validation.reason ?? 'Blink build profile is incompatible.');

    const imported = await import(/* @vite-ignore */ jsUrl) as { default?: BlinkFactory };
    if (typeof imported.default !== 'function') throw new Error('vendored Blink module has no default Emscripten factory export.');
    return { factory: imported.default, wasmUrl };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Blink/WASM Process Sandbox assets are unavailable or incompatible (${detail}). Run \`bun run vendor:blink\` with an active Emscripten toolchain, then rebuild.`);
  }
}

function moduleAliases(module: MaterializedRuntimeModule, interpreterPath: string | null): string[] {
  const names = new Set([module.fileName, module.soname, module.requestedName].filter((name): name is string => !!name));
  const aliases = new Set<string>();
  for (const name of names) {
    for (const directory of ['/lib', '/lib64', '/lib/x86_64-linux-gnu', '/usr/lib', '/usr/lib64', '/usr/lib/x86_64-linux-gnu', '/usr/local/lib']) {
      aliases.add(`${directory}/${name}`);
    }
  }
  if (interpreterPath && names.has(basename(interpreterPath))) aliases.add(interpreterPath);
  return [...aliases];
}

function linkFile(fs: BlinkFs, source: string, destination: string): void {
  if (destination === source) return;
  fs.mkdirTree(parentPath(destination));
  try {
    if (fs.analyzePath?.(destination).exists) fs.unlink(destination);
  } catch { /* missing is fine */ }
  try { fs.symlink(source, destination); }
  catch (error: unknown) {
    throw new Error(`Unable to mount runtime dependency alias ${destination}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function moduleRole(module: MaterializedRuntimeModule, interpreterPath: string | null): RuntimeImageRole {
  if (!interpreterPath) return 'dependency';
  const interpreterName = basename(interpreterPath);
  return module.requestedName === interpreterName || module.fileName === interpreterName || module.soname === interpreterName
    ? 'interpreter'
    : 'dependency';
}

export class BlinkProcessSession {
  private statusValue: ExecutionStatus = 'ready';
  private instructionCountValue = 0;
  private lastInstructionValue: ExecutionInstructionSnapshot | null = null;
  private stdoutValue = '';
  private stderrValue = '';
  private exitCodeValue: number | null = null;
  private trapReasonValue: string | null = null;
  private eventsValue: ExecutionEvent[] = [];
  private module: BlinkModule | null = null;
  private clstruct = 0;
  private stdinBytes: Uint8Array;
  private stdinCursor = 0;
  private fakeTtyPaused = false;
  private processMode: 'none' | 'debug-step' | 'headless-run' = 'none';
  private captureEnabled = false;
  private discardPrelude = false;
  private preludeCursor = 0;
  private disposed = false;
  private runtimeImageResolver: RuntimeImageResolver | null = null;
  private readonly providerDiagnostics = new ExecutionProviderDiagnosticBuffer();

  private constructor(
    readonly file: ProjectFile,
    readonly image: LoadedImage,
    readonly policy: ExecutionPolicy,
    private readonly runtime: BlinkProcessRuntime
  ) {
    this.stdinBytes = new TextEncoder().encode(policy.stdin);
  }

  static async create(
    file: ProjectFile,
    image: LoadedImage,
    policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY,
    runtime: BlinkProcessRuntime = DEFAULT_BLINK_PROCESS_RUNTIME
  ): Promise<BlinkProcessSession> {
    if (file.kind !== 'binary' || !file.bytes) throw new Error('Blink process execution requires authoritative ELF bytes.');
    const session = new BlinkProcessSession(file, image, policy, runtime);
    await session.initialize();
    return session;
  }

  private prepareRuntimeImageResolver(closure: RuntimeDependencyClosure): void {
    const candidates: RuntimeImageCandidate[] = [];
    const fixedBiases = new Map<string, bigint>();
    const programId = `program:${this.file.id}`;
    candidates.push(runtimeImageCandidateFromLoadedImage(programId, this.file.name, 'program', this.file.bytes!, this.image));
    if (this.image.kind === 'executable') fixedBiases.set(programId, 0n);

    for (let index = 0; index < closure.modules.length; index += 1) {
      const module = closure.modules[index];
      const role = moduleRole(module, closure.interpreterPath);
      const id = `${role}:${index}:${module.sourceId}:${module.fileName}`;
      try {
        candidates.push(runtimeImageCandidateFromElfBytes(id, module.fileName, role, module.bytes));
      } catch (error: unknown) {
        this.providerDiagnostics.add('warning', `Runtime image indexing skipped for ${module.fileName}: ${describeExecutionError(error)}`);
      }
    }
    this.runtimeImageResolver = new RuntimeImageResolver(candidates, fixedBiases);
  }

  private async initialize(): Promise<void> {
    const closure = await this.runtime.materialize(this.image.interpreter, this.image.neededLibraries);
    this.prepareRuntimeImageResolver(closure);
    const { factory, wasmUrl } = await this.runtime.loadFactory();

    const stdout = (byte: number) => { if (this.captureEnabled) this.captureOutput('stdout', byte); };
    const stderr = (byte: number) => { if (this.captureEnabled) this.captureOutput('stderr', byte); };
    let module!: BlinkModule;
    module = await factory({
      noInitialRun: true,
      locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path,
      print: (message: unknown) => this.captureProviderDiagnostic('info', message),
      printErr: (message: unknown) => this.captureProviderDiagnostic('warning', message),
      onAbort: (reason: unknown) => this.captureProviderDiagnostic('error', `Blink/WASM abort: ${String(reason)}`),
      preRun: (candidate: BlinkModule) => {
        candidate.FS.init(
          () => this.stdinCursor < this.stdinBytes.length ? this.stdinBytes[this.stdinCursor++] : null,
          stdout,
          stderr
        );
      }
    });
    this.module = module;

    const signalPointer = module.addFunction((signal: number, code: number) => this.onSignal(signal, code), 'vii');
    const exitPointer = module.addFunction((code: number) => this.onExit(code), 'vi');
    module.callMain([String(signalPointer), String(exitPointer)]);

    const programPath = '/program';
    module.FS.writeFile(programPath, new Uint8Array(this.file.bytes!));
    module.FS.chmod(programPath, 0o555);
    module.FS.mkdirTree('/deps');
    for (let index = 0; index < closure.modules.length; index += 1) {
      const dependency = closure.modules[index];
      const storagePath = `/deps/${index}-${dependency.fileName}`;
      module.FS.writeFile(storagePath, new Uint8Array(dependency.bytes));
      module.FS.chmod(storagePath, 0o555);
      for (const alias of moduleAliases(dependency, closure.interpreterPath)) linkFile(module.FS, storagePath, alias);
    }

    this.clstruct = module._blinkenlib_get_clstruct();
    writeCString(module.wasmExports.memory, module._blinkenlib_get_progname_string(), programPath, 200);
    writeCString(module.wasmExports.memory, module._blinkenlib_get_argc_string(), programPath, 200);
    writeCString(module.wasmExports.memory, module._blinkenlib_get_argv_string(), '', 200);

    // Do not call starti() here. The pinned browser fork enables its internal
    // debugger/disassembler in starti/continue mode. On modern glibc dynamic
    // loaders that path can abort inside Blink at a preemption boundary.
    // Preparation therefore materializes the process filesystem only. Step
    // lazily enters debugger mode; Run lazily enters the headless run_fast path.
    this.captureEnabled = true;
    this.stdoutValue = '';
    this.stderrValue = '';
    this.statusValue = 'ready';
    appendEvent(this.eventsValue, {
      kind: 'prepared',
      message: `Blink/WASM materialized ${this.file.name} with ${closure.modules.length} runtime module(s), ${closure.totalBytes.toLocaleString()} dependency bytes. Guest execution has not started yet.`
    });
  }

  private captureProviderDiagnostic(level: 'info' | 'warning' | 'error', value: unknown): void {
    const raw = String(value ?? '').trim();
    if (!raw) return;
    if (raw.includes('warning: unsupported syscall: __syscall_mprotect')) {
      this.providerDiagnostics.add('info', `${raw} [Emscripten compatibility stub; host protection is intentionally a no-op success]`);
      return;
    }
    this.providerDiagnostics.add(level, raw);
  }

  private trapFromError(error: unknown): void {
    const detail = describeExecutionError(error);
    const firstLine = detail.split(/\r?\n/, 1)[0] || String(error);
    this.statusValue = 'trapped';
    this.trapReasonValue = firstLine;
    this.providerDiagnostics.add('error', detail);
    appendEvent(this.eventsValue, { kind: 'trap', reason: this.trapReasonValue });
  }

  private beginProcessOutput(): void {
    // blinkenlib's setupProgram() prints a host-side prompt before entering the
    // guest. It is not guest stdout and must not leak into the sandbox stream.
    this.discardPrelude = true;
    this.preludeCursor = 0;
  }

  private captureOutput(kind: 'stdout' | 'stderr', byte: number): void {
    const text = String.fromCharCode(byte & 0xff);
    if (kind === 'stdout' && this.discardPrelude) {
      const expected = `\n$ /program\n`;
      if (text === expected[this.preludeCursor]) {
        this.preludeCursor += 1;
        if (this.preludeCursor === expected.length) this.discardPrelude = false;
        return;
      }
      // A fork/version drifted from the known prompt. Preserve every byte rather
      // than silently discarding possible guest output.
      if (this.preludeCursor > 0) {
        const prefix = expected.slice(0, this.preludeCursor);
        this.stdoutValue += prefix;
        appendEvent(this.eventsValue, { kind: 'stdout', text: prefix });
      }
      this.discardPrelude = false;
      this.preludeCursor = 0;
    }
    if (kind === 'stdout') this.stdoutValue += text;
    else this.stderrValue += text;
    appendEvent(this.eventsValue, { kind, text });
  }

  private onSignal(signal: number, code: number): void {
    if (this.disposed) return;
    if (signal !== SIGTRAP) {
      const exitCode = 128 + signal;
      this.statusValue = 'trapped';
      this.exitCodeValue = exitCode;
      this.trapReasonValue = `Blink guest terminated by Linux signal ${signal} (exit ${exitCode}).`;
      appendEvent(this.eventsValue, { kind: 'trap', reason: this.trapReasonValue });
      return;
    }
    if (code === BLINK_PREEMPT) return;
    if (code === BLINK_STEP) {
      this.statusValue = 'paused';
      return;
    }
    if (code === BLINK_FAKE_TTY) {
      this.fakeTtyPaused = true;
      this.statusValue = 'paused';
      this.trapReasonValue = 'Guest is waiting for stdin. Preloaded stdin is exhausted; interactive terminal input is not wired yet.';
      return;
    }
    this.statusValue = 'trapped';
    this.trapReasonValue = `Blink reported SIGTRAP code ${code}.`;
    appendEvent(this.eventsValue, { kind: 'trap', reason: this.trapReasonValue });
  }

  private onExit(code: number): void {
    if (this.disposed) return;
    this.statusValue = 'exited';
    this.exitCodeValue = code;
    this.trapReasonValue = null;
    appendEvent(this.eventsValue, { kind: 'exit', code });
  }

  private readRegisters(): ExecutionRegisterSnapshot | null {
    const module = this.module;
    // run_fast deliberately disables Blink's debugger and therefore does not
    // refresh clstruct register pointers. Returning the previous debug snapshot
    // here would be stale and actively misleading.
    if (!module || !this.clstruct || this.processMode === 'headless-run') return null;
    const view = new DataView(module.wasmExports.memory.buffer);
    const valueAt = (index: number): number => view.getUint32(this.clstruct + index * 4, true);
    if (valueAt(CL.version) !== 1) throw new Error(`Blink clstruct version ${valueAt(CL.version)} is incompatible with provider version 1.`);
    const readU64 = (index: number): bigint => {
      const pointer = valueAt(index);
      return pointer ? view.getBigUint64(pointer, true) : 0n;
    };
    const csBase = readU64(CL.csBase);
    return {
      rax: readU64(CL.rax), rbx: readU64(CL.rbx), rcx: readU64(CL.rcx), rdx: readU64(CL.rdx),
      rsi: readU64(CL.rsi), rdi: readU64(CL.rdi), rbp: readU64(CL.rbp), rsp: readU64(CL.rsp),
      rip: (csBase + readU64(CL.rip)) & ((1n << 64n) - 1n),
      r8: readU64(CL.r8), r9: readU64(CL.r9), r10: readU64(CL.r10), r11: readU64(CL.r11),
      r12: readU64(CL.r12), r13: readU64(CL.r13), r14: readU64(CL.r14), r15: readU64(CL.r15),
      rflags: readU64(CL.flags)
    };
  }

  private readRuntimeDisassembly(rip: bigint | null | undefined): ExecutionRuntimeDisassemblySnapshot | null {
    const module = this.module;
    if (!module || !this.clstruct || this.processMode !== 'debug-step') return null;
    const view = new DataView(module.wasmExports.memory.buffer);
    const valueAt = (index: number): number => view.getUint32(this.clstruct + index * 4, true);
    if (valueAt(CL.version) !== 1) return null;

    const maxLines = valueAt(CL.disMaxLines);
    const maxLineLen = valueAt(CL.disMaxLineLen);
    const currentLine = valueAt(CL.disCurrentLine);
    const buffer = valueAt(CL.disBuffer);
    if (!buffer || maxLines <= 0 || maxLineLen <= 0 || currentLine >= maxLines) return null;

    // The fork exposes a fixed char[lines][line_len] matrix. Copy strings into
    // the snapshot immediately because Emscripten memory can grow between UI
    // renders and invalidate any retained DataView/TypedArray references.
    const heap = new Uint8Array(module.wasmExports.memory.buffer);
    const lines: string[] = [];
    let lastNonEmpty = -1;
    for (let line = 0; line < maxLines; line += 1) {
      const start = buffer + line * maxLineLen;
      if (start >= heap.byteLength) break;
      const limit = Math.min(heap.byteLength, start + maxLineLen);
      let text = '';
      for (let cursor = start; cursor < limit; cursor += 1) {
        const byte = heap[cursor];
        if (byte === 0) break;
        text += String.fromCharCode(byte);
      }
      lines.push(text);
      if (text.trim()) lastNonEmpty = line;
    }
    if (lastNonEmpty < 0 || currentLine >= lines.length) return null;
    const visibleLines = lines.slice(0, Math.max(lastNonEmpty + 1, currentLine + 1));
    let image: ExecutionRuntimeImageSnapshot | null = null;
    if (rip !== null && rip !== undefined && this.runtimeImageResolver) {
      try {
        const match = this.runtimeImageResolver.resolve(visibleLines, rip, currentLine);
        if (match) {
          image = {
            name: match.name,
            role: match.role,
            runtimeAddress: match.runtimeAddress,
            imageAddress: match.imageAddress,
            loadBias: match.loadBias,
            confidence: match.confidence,
            signatureBytes: match.signatureBytes
          };
        }
      } catch (error: unknown) {
        this.providerDiagnostics.add('warning', `Blink runtime image identity unavailable: ${describeExecutionError(error)}`);
      }
    }
    return {
      source: 'blink-debugger',
      lines: visibleLines,
      currentLine,
      image
    };
  }

  private recordSteppedProgramInstruction(): void {
    if (!this.runtimeImageResolver) return;
    try {
      const registers = this.readRegisters();
      const runtime = this.readRuntimeDisassembly(registers?.rip);
      if (!runtime) return;
      const executed = blinkRuntimeInstructionLine(runtime.lines[runtime.currentLine] ?? '', runtime.currentLine);
      if (!executed) return;
      const match = this.runtimeImageResolver.resolve(runtime.lines, executed.address, runtime.currentLine);
      if (!match || match.role !== 'program') {
        this.lastInstructionValue = null;
        return;
      }
      const address = Number(match.imageAddress);
      const endAddress = Number(match.imageAddress + BigInt(executed.bytes.length));
      if (!Number.isSafeInteger(address) || !Number.isSafeInteger(endAddress)) {
        this.providerDiagnostics.add('warning', `Program instruction address ${match.imageAddress.toString(16)} exceeds browser-safe analysis range.`);
        this.lastInstructionValue = null;
        return;
      }
      const instruction: ExecutionInstructionSnapshot = {
        address,
        endAddress,
        mnemonic: executed.mnemonic,
        operands: executed.operands
      };
      this.lastInstructionValue = instruction;
      appendEvent(this.eventsValue, {
        kind: 'instruction',
        address,
        mnemonic: executed.mnemonic,
        operands: executed.operands
      });
    } catch (error: unknown) {
      this.providerDiagnostics.add('warning', `Blink stepped-instruction projection unavailable: ${describeExecutionError(error)}`);
      this.lastInstructionValue = null;
    }
  }

  get status(): ExecutionStatus { return this.statusValue; }

  markRunning(): void {
    if (this.statusValue === 'ready' || this.statusValue === 'paused') {
      this.trapReasonValue = null;
      this.statusValue = 'running';
    }
  }

  pause(): void {
    // Blink returns to JS every bounded preemption quantum. We stop scheduling the next quantum.
    if (this.statusValue === 'running') this.statusValue = 'paused';
  }

  step(): ExecutionSnapshot {
    if (!this.module || terminal(this.statusValue)) return this.snapshot();
    this.trapReasonValue = null;
    this.fakeTtyPaused = false;
    if (this.processMode === 'headless-run') {
      this.statusValue = 'trapped';
      this.trapReasonValue = 'Blink headless Run mode cannot switch to instruction stepping in-place. Reset the process before Step.';
      appendEvent(this.eventsValue, { kind: 'trap', reason: this.trapReasonValue });
      return this.snapshot();
    }
    this.statusValue = 'running';
    try {
      if (this.processMode === 'none') {
        this.beginProcessOutput();
        this.module._blinkenlib_starti();
        this.processMode = 'debug-step';
        appendEvent(this.eventsValue, {
          kind: 'prepared',
          message: 'Blink debugger mode initialized for instruction stepping. Use Reset before Run; process Run uses the headless compatibility path.'
        });
      }
      this.module._blinkenlib_stepi();
      this.instructionCountValue += 1;
      this.recordSteppedProgramInstruction();
      if (this.statusValue === 'running') this.statusValue = 'paused';
    } catch (error: unknown) {
      this.trapFromError(error);
    }
    return this.snapshot();
  }

  runSlice(_maxInstructions = 500): ExecutionSnapshot {
    if (!this.module || terminal(this.statusValue)) return this.snapshot();
    this.markRunning();
    if (this.processMode === 'debug-step') {
      this.statusValue = 'trapped';
      this.trapReasonValue = 'Blink debugger continuation is disabled because the pinned browser fork can abort in its internal disassembler at preemption boundaries. Reset, then Run to use headless process execution.';
      appendEvent(this.eventsValue, { kind: 'trap', reason: this.trapReasonValue });
      return this.snapshot();
    }
    try {
      if (this.fakeTtyPaused && this.module._blinkenlib_faketty_resume) {
        this.fakeTtyPaused = false;
        this.module._blinkenlib_faketty_resume();
      } else if (this.processMode === 'none') {
        this.beginProcessOutput();
        this.processMode = 'headless-run';
        appendEvent(this.eventsValue, {
          kind: 'prepared',
          message: 'Blink headless process execution started. Internal Blink disassembly is disabled; analyzer/Capstone remains authoritative for code inspection.'
        });
        this.module._blinkenlib_run_fast();
      } else {
        this.module._blinkenlib_preempt_resume();
      }
    } catch (error: unknown) {
      this.trapFromError(error);
    }
    return this.snapshot();
  }

  snapshot(): ExecutionSnapshot {
    let registers: ExecutionRegisterSnapshot | null = null;
    let runtimeDisassembly: ExecutionRuntimeDisassemblySnapshot | null = null;
    try { registers = this.readRegisters(); }
    catch (error: unknown) {
      if (!terminal(this.statusValue)) this.trapFromError(error);
      else this.providerDiagnostics.add('error', describeExecutionError(error));
    }
    try { runtimeDisassembly = this.readRuntimeDisassembly(registers?.rip); }
    catch (error: unknown) {
      this.providerDiagnostics.add('warning', `Blink live disassembly unavailable: ${describeExecutionError(error)}`);
    }
    return {
      status: this.statusValue,
      targetFileId: this.file.id,
      targetName: this.file.name,
      imageKind: this.image.kind,
      provider: 'blink-process',
      instructionCount: this.instructionCountValue,
      registers,
      lastInstruction: this.lastInstructionValue,
      runtimeDisassembly,
      stdout: this.stdoutValue,
      stderr: this.stderrValue,
      exitCode: this.exitCodeValue,
      trapReason: this.trapReasonValue,
      providerDiagnostics: this.providerDiagnostics.snapshot(),
      events: this.eventsValue.slice()
    };
  }

  dispose(): void {
    this.disposed = true;
    this.module = null;
    this.runtimeImageResolver = null;
  }
}
