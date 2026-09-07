import {
  BlinkToolProcessRunner,
  type BlinkToolFactory,
  type BlinkToolFs,
  type BlinkToolModule,
  type BlinkToolRuntime
} from '../../src/features/toolchain/blinkToolProcessRunner';
import { makeMinimalStaticElf } from '../execution/headless-fixtures';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readCString(memory: WebAssembly.Memory, address: number): string {
  const heap = new Uint8Array(memory.buffer);
  let text = '';
  for (let cursor = address; cursor < heap.length && heap[cursor]; cursor += 1) text += String.fromCharCode(heap[cursor]);
  return text;
}

class FakeFs implements BlinkToolFs {
  readonly files = new Map<string, Uint8Array>();
  readonly modes = new Map<string, number>();
  cwd = '/';
  input: (() => number | null) | null = null;
  output: ((byte: number) => void) | null = null;
  error: ((byte: number) => void) | null = null;

  init(input: () => number | null, output: (byte: number) => void, error: (byte: number) => void): void {
    this.input = input;
    this.output = output;
    this.error = error;
  }

  mkdirTree(_path: string): void {}

  writeFile(path: string, data: Uint8Array): void {
    this.files.set(path, data.slice());
  }

  readFile(path: string): Uint8Array {
    const value = this.files.get(path);
    if (!value) throw new Error(`ENOENT: ${path}`);
    return value.slice();
  }

  chmod(path: string, mode: number): void {
    this.modes.set(path, mode);
  }

  chdir(path: string): void {
    this.cwd = path;
  }

  emit(target: 'stdout' | 'stderr', text: string): void {
    const fn = target === 'stdout' ? this.output : this.error;
    for (const byte of new TextEncoder().encode(text)) fn?.(byte);
  }
}

class FakeBlinkModule implements BlinkToolModule {
  readonly FS = new FakeFs();
  readonly wasmExports = { memory: new WebAssembly.Memory({ initial: 1 }) };
  private readonly callbacks = new Map<number, (...args: number[]) => void>();
  private nextCallback = 1;
  private signalCallback = 0;
  private exitCallback = 0;
  readonly prognamePtr = 0x1000;
  readonly argcPtr = 0x1200;
  readonly argvPtr = 0x1400;
  commandSeen = '';
  stdinSeen: number | null = null;

  addFunction(callback: (...args: number[]) => void, _signature: string): number {
    const id = this.nextCallback++;
    this.callbacks.set(id, callback);
    return id;
  }

  callMain(args: string[]): void {
    this.signalCallback = Number(args[0]);
    this.exitCallback = Number(args[1]);
  }

  _blinkenlib_get_argc_string(): number { return this.argcPtr; }
  _blinkenlib_get_argv_string(): number { return this.argvPtr; }
  _blinkenlib_get_progname_string(): number { return this.prognamePtr; }

  _blinkenlib_run_fast(): void {
    this.callbacks.get(this.signalCallback)?.(5, 40);
  }

  _blinkenlib_preempt_resume(): void {
    this.commandSeen = readCString(this.wasmExports.memory, this.argcPtr);
    this.stdinSeen = this.FS.input?.() ?? null;
    this.FS.emit('stdout', 'tool-out\n');
    this.FS.emit('stderr', 'tool-err\n');
    this.FS.writeFile('/work/out/result.bin', Uint8Array.from([1, 2, 3, 4]));
    this.callbacks.get(this.exitCallback)?.(0);
  }
}

let latestModule: FakeBlinkModule | null = null;
const factory: BlinkToolFactory = async (options) => {
  const module = new FakeBlinkModule();
  latestModule = module;
  const preRun = options.preRun as ((candidate: BlinkToolModule) => void) | undefined;
  preRun?.(module);
  return module;
};
const runtime: BlinkToolRuntime = {
  loadFactory: async () => ({ factory, wasmUrl: '/fake/blink.wasm' })
};
const toolBytes = new Uint8Array(makeMinimalStaticElf());

const runner = new BlinkToolProcessRunner({
  runtime,
  toolchainFiles: [{ path: '/toolchain/bin/minitool', bytes: toolBytes, executable: true }]
});
const result = await runner.run({
  executable: '/toolchain/bin/minitool',
  args: ['--mode', 'copy', '/work/input.txt'],
  cwd: '/work',
  files: [{ path: '/work/input.txt', bytes: new TextEncoder().encode('input') }],
  captureFiles: ['/work/out/result.bin'],
  stdin: Uint8Array.from([0x41])
});

assert(result.exitCode === 0, 'tool fixture should exit 0');
assert(result.stdout === 'tool-out\n', `unexpected stdout: ${JSON.stringify(result.stdout)}`);
assert(result.stderr === 'tool-err\n', `unexpected stderr: ${JSON.stringify(result.stderr)}`);
assert(result.files.length === 1 && result.files[0].bytes.join(',') === '1,2,3,4', 'declared output file should be captured from MEMFS');
assert(latestModule !== null, 'fake Blink module should have been instantiated');
const module = latestModule as FakeBlinkModule;
assert(module.commandSeen === '/toolchain/bin/minitool --mode copy /work/input.txt', `unexpected command bridge: ${module.commandSeen}`);
assert(module.stdinSeen === 0x41, 'preloaded stdin should be exposed to the tool process');
assert(module.FS.cwd === '/work', 'tool process should run in its requested /work cwd');
assert(module.FS.files.has('/toolchain/bin/minitool'), 'explicit toolchain executable must be mounted');
assert(module.FS.modes.get('/toolchain/bin/minitool') === 0o555, 'toolchain executable must be mounted executable');
assert(module.FS.files.has('/work/input.txt'), 'explicit work input must be mounted');

let rejectedOutsideWork = false;
try {
  await runner.run({
    executable: '/toolchain/bin/minitool',
    args: [],
    cwd: '/work',
    files: [{ path: '/etc/passwd', bytes: new Uint8Array() }],
    captureFiles: []
  });
} catch {
  rejectedOutsideWork = true;
}
assert(rejectedOutsideWork, 'tool runner must reject request files outside /work');

const boundedRunner = new BlinkToolProcessRunner({
  runtime,
  policy: { maxOutputBytes: 4 },
  toolchainFiles: [{ path: '/toolchain/bin/minitool', bytes: toolBytes, executable: true }]
});
let outputBounded = false;
try {
  await boundedRunner.run({ executable: '/toolchain/bin/minitool', args: [], cwd: '/work', files: [], captureFiles: [] });
} catch (error: unknown) {
  outputBounded = error instanceof Error && error.message.includes('output budget exceeded');
}
assert(outputBounded, 'tool runner must reject a process that exceeds its output budget');

console.log('Blink tool runner smoke: PASS (isolated MEMFS + preemption + capture + policy bounds)');
