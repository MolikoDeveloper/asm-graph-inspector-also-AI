import type { LoadedImage } from '../../src/features/binary/model';
import type { ProjectFile } from '../../src/features/project/model';
import { BlinkProcessSession, type BlinkModule, type BlinkProcessRuntime } from '../../src/features/execution/blinkProcessSession';
import { DEFAULT_EXECUTION_POLICY } from '../../src/features/execution/model';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertIncludes(actual: string | null | undefined, expected: string, label: string): void {
  if (!actual?.includes(expected)) throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
}

class AbortDiagnosticModule implements BlinkModule {
  readonly wasmExports = { memory: new WebAssembly.Memory({ initial: 1 }) };
  readonly FS = {
    init: (_input: () => number | null, _output: (byte: number) => void, _error: (byte: number) => void) => {},
    mkdirTree: (_path: string) => {},
    writeFile: (_path: string, _data: Uint8Array) => {},
    chmod: (_path: string, _mode: number) => {},
    symlink: (_target: string, _linkpath: string) => {},
    unlink: (_path: string) => {},
    analyzePath: (_path: string) => ({ exists: false })
  };

  constructor(private readonly options: Record<string, unknown>) {}

  addFunction(_callback: (...args: number[]) => void): number { return 1; }
  callMain(_args: string[]): void {}
  _blinkenlib_get_clstruct(): number { return 0; }
  _blinkenlib_get_argc_string(): number { return 512; }
  _blinkenlib_get_argv_string(): number { return 768; }
  _blinkenlib_get_progname_string(): number { return 1024; }
  _blinkenlib_starti(): void {}
  _blinkenlib_stepi(): void {}
  _blinkenlib_continue(): void {}
  _blinkenlib_preempt_resume(): void {}

  _blinkenlib_run_fast(): void {
    const printErr = this.options.printErr as ((message: unknown) => void) | undefined;
    const onAbort = this.options.onAbort as ((reason: unknown) => void) | undefined;
    for (let index = 0; index < 13; index += 1) printErr?.('warning: unsupported syscall: __syscall_mprotect');
    onAbort?.('native code called abort()');
    const error = new Error('Aborted(native code called abort())');
    error.stack = 'Error: Aborted(native code called abort())\n    at wasm-function[183496]:0x1234\n    at runLoop (blinkenlib.wasm:0x5678)';
    throw error;
  }
}

let module: AbortDiagnosticModule | null = null;
const runtime: BlinkProcessRuntime = {
  async materialize(interpreterPath) {
    return { interpreterPath, modules: [], totalBytes: 0 };
  },
  async loadFactory() {
    return {
      wasmUrl: 'memory://blinkenlib.wasm',
      factory: async (options) => {
        module = new AbortDiagnosticModule(options);
        const preRun = options.preRun as ((candidate: BlinkModule) => void) | undefined;
        preRun?.(module);
        return module;
      }
    };
  }
};

const bytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]).buffer;
const file: ProjectFile = {
  id: 'blink-diagnostic-smoke', path: 'blink-diagnostic-smoke', name: 'blink-diagnostic-smoke', kind: 'binary', language: 'binary', bytes, size: bytes.byteLength, updatedAt: 1
};
const image = {
  schema: 'asm-graph.loaded-image/v1', sourceFileId: file.id, sourcePath: file.path, architecture: 'x86-64', byteOrder: 'little', kind: 'executable', entry: 0x406820, buildId: null, soname: null,
  neededLibraries: ['libc.so.6'], interpreter: '/lib64/ld-linux-x86-64.so.2', segments: [], sections: [], symbols: [], relocations: [], functions: [],
  unwind: { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 }
} as LoadedImage;

const session = await BlinkProcessSession.create(file, image, DEFAULT_EXECUTION_POLICY, runtime);
try {
  const snapshot = session.runSlice();
  assertEqual(snapshot.status, 'trapped', 'diagnostic trap status');
  assertIncludes(snapshot.trapReason, 'Aborted(native code called abort())', 'diagnostic trap reason');

  const mprotect = snapshot.providerDiagnostics.find((item) => item.message.includes('__syscall_mprotect'));
  assertEqual(mprotect?.level, 'info', 'mprotect diagnostic classification');
  assertEqual(mprotect?.count, 13, 'mprotect diagnostic aggregation');
  assertIncludes(mprotect?.message, 'no-op success', 'mprotect compatibility note');

  const abort = snapshot.providerDiagnostics.find((item) => item.message.includes('Blink/WASM abort: native code called abort()'));
  assertEqual(abort?.level, 'error', 'onAbort diagnostic classification');

  const stack = snapshot.providerDiagnostics.find((item) => item.message.includes('wasm-function[183496]'));
  assertEqual(stack?.level, 'error', 'caught stack diagnostic classification');
} finally {
  session.dispose();
}

console.log('blink provider diagnostic smoke: PASS (mprotect warning aggregation + onAbort + WASM stack capture)');
