import type { ElfSymbol, LoadedImage } from '../../src/features/binary/model';
import type { ProjectFile } from '../../src/features/project/model';
import { BlinkProcessSession, type BlinkModule, type BlinkProcessRuntime } from '../../src/features/execution/blinkProcessSession';
import { DEFAULT_EXECUTION_POLICY } from '../../src/features/execution/model';
import { blinkDisassemblyLineText, blinkRuntimeCursorLine } from '../../src/features/execution/runtimeDisassembly';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertIncludes(actual: string | null, expected: string, label: string): void {
  if (!actual?.includes(expected)) throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}

const CLSTRUCT = 4096;
const CL = { version: 0, flags: 7, csBase: 8, rip: 9, rsp: 10, rbp: 11, rsi: 12, rdi: 13, r8: 14, r9: 15, r10: 16, r11: 17, r12: 18, r13: 19, r14: 20, r15: 21, rax: 22, rbx: 23, rcx: 24, rdx: 25, disMaxLines: 26, disMaxLineLen: 27, disCurrentLine: 28, disBuffer: 29 } as const;
const ENTRY = 0x406820n;
const DIS_BUFFER = 16384;
const DIS_MAX_LINES = 4;
const DIS_LINE_LEN = 160;

type FakeRunOutcome = 'exit' | 'sigill';

class FakeBlinkModule implements BlinkModule {
  readonly wasmExports = { memory: new WebAssembly.Memory({ initial: 1 }) };
  readonly callbacks = new Map<number, (...args: number[]) => void>();
  private callbackId = 100;
  private exitCallbackId: number | null = null;
  private signalCallbackId: number | null = null;
  private input: (() => number | null) | null = null;
  private output: ((byte: number) => void) | null = null;
  private error: ((byte: number) => void) | null = null;

  readonly FS = {
    init: (input: () => number | null, output: (byte: number) => void, error: (byte: number) => void) => { this.input = input; this.output = output; this.error = error; },
    mkdirTree: (_path: string) => {},
    writeFile: (_path: string, _data: Uint8Array) => {},
    chmod: (_path: string, _mode: number) => {},
    symlink: (_target: string, _linkpath: string) => {},
    unlink: (_path: string) => {},
    analyzePath: (_path: string) => ({ exists: false })
  };

  constructor(private readonly runOutcome: FakeRunOutcome = 'exit') {
    const view = new DataView(this.wasmExports.memory.buffer);
    view.setUint32(CLSTRUCT + CL.version * 4, 1, true);
    let pointer = 8192;
    for (const index of [CL.flags, CL.csBase, CL.rip, CL.rsp, CL.rbp, CL.rsi, CL.rdi, CL.r8, CL.r9, CL.r10, CL.r11, CL.r12, CL.r13, CL.r14, CL.r15, CL.rax, CL.rbx, CL.rcx, CL.rdx]) {
      view.setUint32(CLSTRUCT + index * 4, pointer, true);
      view.setBigUint64(pointer, 0n, true);
      pointer += 16;
    }
    view.setUint32(CLSTRUCT + CL.disMaxLines * 4, DIS_MAX_LINES, true);
    view.setUint32(CLSTRUCT + CL.disMaxLineLen * 4, DIS_LINE_LEN, true);
    view.setUint32(CLSTRUCT + CL.disCurrentLine * 4, 0, true);
    view.setUint32(CLSTRUCT + CL.disBuffer * 4, DIS_BUFFER, true);
    this.writeRegister(CL.rip, ENTRY);
    this.writeRegister(CL.rsp, 0x7fff_ffff_f000n);
    this.writeRegister(CL.flags, 0x202n);
    this.writeDisassembly([
      '<td class="addr">0000000000406820</td><td class="hex">48 31 ed</td><td class="str">xor rbp, rbp</td>',
      '<td class="addr">0000000000406824</td><td class="hex">49 89 d1</td><td class="str">mov r9, rdx</td>',
      '<td class="addr">0000000000406828</td><td class="hex">5e</td><td class="str">pop rsi</td>'
    ]);
  }

  private writeDisassembly(lines: string[]): void {
    const heap = new Uint8Array(this.wasmExports.memory.buffer);
    heap.fill(0, DIS_BUFFER, DIS_BUFFER + DIS_MAX_LINES * DIS_LINE_LEN);
    for (let index = 0; index < Math.min(lines.length, DIS_MAX_LINES); index += 1) {
      const encoded = new TextEncoder().encode(lines[index]);
      heap.set(encoded.subarray(0, DIS_LINE_LEN - 1), DIS_BUFFER + index * DIS_LINE_LEN);
    }
  }

  private registerPointer(index: number): number {
    return new DataView(this.wasmExports.memory.buffer).getUint32(CLSTRUCT + index * 4, true);
  }

  private readRegister(index: number): bigint {
    const pointer = this.registerPointer(index);
    return new DataView(this.wasmExports.memory.buffer).getBigUint64(pointer, true);
  }

  private writeRegister(index: number, value: bigint): void {
    const pointer = this.registerPointer(index);
    new DataView(this.wasmExports.memory.buffer).setBigUint64(pointer, value, true);
  }

  addFunction(callback: (...args: number[]) => void): number {
    const id = this.callbackId++;
    this.callbacks.set(id, callback);
    return id;
  }

  callMain(args: string[]): void {
    this.signalCallbackId = Number(args[0]);
    this.exitCallbackId = Number(args[1]);
  }

  _blinkenlib_get_clstruct(): number { return CLSTRUCT; }
  _blinkenlib_get_argc_string(): number { return 512; }
  _blinkenlib_get_argv_string(): number { return 768; }
  _blinkenlib_get_progname_string(): number { return 1024; }

  _blinkenlib_run_fast(): void {
    if (this.runOutcome === 'sigill') {
      // Model the patched wrapper contract: architectural state is refreshed
      // before the fatal signal callback crosses the WASM -> JS boundary.
      this.writeRegister(CL.rip, ENTRY + 4n);
      this.writeRegister(CL.rax, 0x1234n);
      if (this.signalCallbackId !== null) this.callbacks.get(this.signalCallbackId)?.(4, 2);
      return;
    }
    this.output?.('h'.charCodeAt(0));
    this.output?.('i'.charCodeAt(0));
    this.output?.('\n'.charCodeAt(0));
    this.writeRegister(CL.rip, ENTRY + 8n);
    if (this.exitCallbackId !== null) this.callbacks.get(this.exitCallbackId)?.(0);
  }

  _blinkenlib_starti(): void {
    this.writeRegister(CL.rip, ENTRY);
    new DataView(this.wasmExports.memory.buffer).setUint32(CLSTRUCT + CL.disCurrentLine * 4, 0, true);
  }

  _blinkenlib_stepi(): void {
    this.writeRegister(CL.rip, this.readRegister(CL.rip) + 4n);
    // Blink's provider cursor identifies the instruction that just executed;
    // the UI should prefer the architectural RIP (the next instruction).
    new DataView(this.wasmExports.memory.buffer).setUint32(CLSTRUCT + CL.disCurrentLine * 4, 0, true);
  }

  _blinkenlib_continue(): void {}
  _blinkenlib_preempt_resume(): void {
    if (this.signalCallbackId !== null) this.callbacks.get(this.signalCallbackId)?.(5, 40);
  }
  _blinkenlib_faketty_resume(): void { this.input?.(); this.error?.(0); }
}

function runtimeFor(module: FakeBlinkModule): BlinkProcessRuntime {
  return {
    async materialize(interpreterPath, _directNeeded) {
      return { interpreterPath, modules: [], totalBytes: 0 };
    },
    async loadFactory() {
      return {
        wasmUrl: 'memory://blinkenlib.wasm',
        factory: async (options) => {
          const preRun = options.preRun as ((candidate: BlinkModule) => void) | undefined;
          preRun?.(module);
          return module;
        }
      };
    }
  };
}

const programBytes = new Uint8Array(256);
programBytes.fill(0x90);
programBytes.set([0x48, 0x31, 0xed], 0x20);
programBytes.set([0x49, 0x89, 0xd1], 0x24);
programBytes.set([0x5e], 0x28);
const bytes = programBytes.buffer;
const file: ProjectFile = {
  id: 'blink-smoke', path: 'blink-smoke', name: 'blink-smoke', kind: 'binary', language: 'binary', bytes, size: bytes.byteLength, updatedAt: 1
};
const startSymbol: ElfSymbol = {
  index: 0,
  tableSectionIndex: 0,
  name: '_start',
  value: Number(ENTRY),
  size: 16,
  binding: 1,
  type: 2,
  visibility: 0,
  sectionIndex: 1,
  defined: true,
  functionLike: true
};
const image = {
  schema: 'asm-graph.loaded-image/v1', sourceFileId: file.id, sourcePath: file.path, architecture: 'x86-64', byteOrder: 'little', kind: 'executable', entry: Number(ENTRY), buildId: null, soname: null,
  neededLibraries: ['libc.so.6'], interpreter: '/lib64/ld-linux-x86-64.so.2',
  segments: [{
    index: 0, type: 1, flags: 5, offset: 0, virtualAddress: Number(ENTRY) - 0x20,
    fileSize: bytes.byteLength, memorySize: bytes.byteLength, alignment: 0x1000,
    readable: true, writable: false, executable: true
  }],
  sections: [], symbols: [startSymbol], relocations: [], functions: [startSymbol],
  unwind: { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 }
} as LoadedImage;

const stepModule = new FakeBlinkModule();
const stepSession = await BlinkProcessSession.create(file, image, DEFAULT_EXECUTION_POLICY, runtimeFor(stepModule));
try {
  assertEqual(stepSession.snapshot().status, 'ready', 'Blink prepare status');
  const stepped = stepSession.step();
  assertEqual(stepped.status, 'paused', 'Blink step status');
  assertEqual(stepped.instructionCount, 1, 'Blink step count');
  assertEqual(stepped.registers?.rip, ENTRY + 4n, 'Blink stepped RIP');
  assertEqual(stepped.runtimeDisassembly?.source, 'blink-debugger', 'Blink live disassembly source');
  assertEqual(stepped.runtimeDisassembly?.currentLine, 0, 'Blink provider last-executed cursor');
  assertEqual(stepped.runtimeDisassembly?.lines.length, 3, 'Blink live disassembly line count');
  assertEqual(stepped.runtimeDisassembly?.image?.name, 'blink-smoke', 'Blink next-RIP image name');
  assertEqual(stepped.runtimeDisassembly?.image?.role, 'program', 'Blink next-RIP image role');
  assertEqual(stepped.runtimeDisassembly?.image?.imageAddress, ENTRY + 4n, 'Blink next-RIP image address');
  assertEqual(stepped.runtimeDisassembly?.image?.loadBias, 0n, 'Blink ET_EXEC load bias');
  assertEqual(stepped.lastInstruction?.address, Number(ENTRY), 'Blink executed instruction projects to canonical program address');
  assertEqual(stepped.events.filter((event) => event.kind === 'instruction').length, 1, 'Blink program instruction event count');
  assertEqual(
    blinkDisassemblyLineText(stepped.runtimeDisassembly?.lines[1] ?? ''),
    '0000000000406824\t49 89 d1\tmov r9, rdx',
    'Blink live disassembly markup stripping'
  );
  assertEqual(
    blinkRuntimeCursorLine(stepped.runtimeDisassembly?.lines ?? [], stepped.registers?.rip, stepped.runtimeDisassembly?.currentLine ?? 0),
    1,
    'Blink UI cursor follows architectural RIP'
  );

  const forbiddenContinue = stepSession.runSlice();
  assertEqual(forbiddenContinue.status, 'trapped', 'Step -> Run boundary status');
  assertIncludes(forbiddenContinue.trapReason, 'Reset, then Run', 'Step -> Run boundary trap');
} finally {
  stepSession.dispose();
}

const runModule = new FakeBlinkModule('exit');
const runSession = await BlinkProcessSession.create(file, image, DEFAULT_EXECUTION_POLICY, runtimeFor(runModule));
try {
  const exited = runSession.runSlice();
  assertEqual(exited.status, 'exited', 'Blink headless Run status');
  assertEqual(exited.exitCode, 0, 'Blink headless Run exit code');
  assertEqual(exited.stdout, 'hi\n', 'Blink headless Run stdout');
  assertEqual(exited.registers?.rip, ENTRY + 8n, 'Blink headless Run publishes fresh registers');
  assertEqual(exited.crash ?? null, null, 'successful Blink Run has no crash evidence');
} finally {
  runSession.dispose();
}

const crashModule = new FakeBlinkModule('sigill');
const crashSession = await BlinkProcessSession.create(file, image, DEFAULT_EXECUTION_POLICY, runtimeFor(crashModule));
try {
  const trapped = crashSession.runSlice();
  assertEqual(trapped.status, 'trapped', 'Blink headless fatal signal status');
  assertEqual(trapped.exitCode, 132, 'SIGILL shell-style exit code');
  assertEqual(trapped.registers?.rip, ENTRY + 4n, 'fatal-signal register RIP');
  assertEqual(trapped.registers?.rax, 0x1234n, 'fatal-signal general register');
  assertEqual(trapped.crash?.signal, 4, 'fatal-signal number');
  assertEqual(trapped.crash?.signalName, 'SIGILL', 'fatal-signal name');
  assertEqual(trapped.crash?.signalCode, 2, 'fatal-signal code');
  assertEqual(trapped.crash?.runtimeAddress, ENTRY + 4n, 'observed crash runtime RIP');
  assertEqual(trapped.crash?.imageName, 'blink-smoke', 'observed crash image');
  assertEqual(trapped.crash?.imageRole, 'program', 'observed crash image role');
  assertEqual(trapped.crash?.imageAddress, ENTRY + 4n, 'observed crash ELF address');
  assertEqual(trapped.crash?.functionName, '_start', 'observed crash function');
  assertEqual(trapped.crash?.functionOffset, 4, 'observed crash function offset');
  assertEqual(trapped.crash?.codeBytes.slice(0, 3).join(' '), '73 137 209', 'observed crash raw instruction bytes');
  assertIncludes(trapped.trapReason, 'SIGILL', 'fatal-signal diagnostic signal');
  assertIncludes(trapped.trapReason, 'RIP 0x406824', 'fatal-signal diagnostic RIP');
  assertIncludes(trapped.trapReason, '_start+0x4', 'fatal-signal diagnostic function');
} finally {
  crashSession.dispose();
}

console.log('blink process state smoke: PASS (Step image identity + headless fresh registers + observed fatal-signal RIP/function/bytes)');
