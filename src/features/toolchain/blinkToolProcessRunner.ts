import { validateBlinkBuildProfile } from '../execution/blinkBuildProfile';
import type { ToolFile, ToolProcessRequest, ToolProcessResult, ToolProcessRunner } from './toolProcess';

const SIGTRAP = 5;
const BLINK_PREEMPT = 40;
const BLINK_FAKE_TTY = 42;
const BLINK_ARG_BUFFER_BYTES = 200;

export interface BlinkToolFs {
  init(input: () => number | null, output: (byte: number) => void, error: (byte: number) => void): void;
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string, options?: { encoding?: 'binary' }): Uint8Array | string;
  chmod(path: string, mode: number): void;
  chdir(path: string): void;
}

export interface BlinkToolModule {
  FS: BlinkToolFs;
  wasmExports: { memory: WebAssembly.Memory };
  addFunction(callback: (...args: number[]) => void, signature: string): number;
  callMain(args: string[]): void;
  _blinkenlib_get_argc_string(): number;
  _blinkenlib_get_argv_string(): number;
  _blinkenlib_get_progname_string(): number;
  _blinkenlib_run_fast(): void;
  _blinkenlib_preempt_resume(): void;
}

export type BlinkToolFactory = (options: Record<string, unknown>) => Promise<BlinkToolModule>;

export interface BlinkToolRuntime {
  loadFactory(): Promise<{ factory: BlinkToolFactory; wasmUrl: string }>;
}

export interface BlinkToolProcessPolicy {
  maxRuntimeMs: number;
  maxOutputBytes: number;
  maxPreemptions: number;
  maxMountedBytes: number;
  maxCapturedBytes: number;
}

export const DEFAULT_BLINK_TOOL_PROCESS_POLICY: BlinkToolProcessPolicy = Object.freeze({
  maxRuntimeMs: 30_000,
  maxOutputBytes: 1024 * 1024,
  maxPreemptions: 1000,
  maxMountedBytes: 64 * 1024 * 1024,
  maxCapturedBytes: 64 * 1024 * 1024
});

export interface BlinkToolProcessRunnerOptions {
  toolchainFiles: ToolFile[];
  policy?: Partial<BlinkToolProcessPolicy>;
  runtime?: BlinkToolRuntime;
}

const DEFAULT_BLINK_TOOL_RUNTIME: BlinkToolRuntime = Object.freeze({
  loadFactory: loadBlinkToolFactory
});

function normalizeAbsolutePath(path: string): string {
  const source = path.replace(/\\/g, '/');
  if (!source.startsWith('/')) throw new Error(`Tool sandbox path must be absolute: ${path}`);
  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`Tool sandbox path may not contain '..': ${path}`);
    if (part.includes('\0')) throw new Error(`Tool sandbox path contains NUL: ${path}`);
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function requireNamespace(path: string, root: '/toolchain' | '/work', label: string): string {
  const normalized = normalizeAbsolutePath(path);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`${label} must stay inside ${root}: ${path}`);
  }
  return normalized;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function commandToken(value: string, label: string): string {
  if (!value || /\s|\0/.test(value)) {
    throw new Error(`${label} contains whitespace or NUL, which the pinned Blink argv bridge cannot represent: ${JSON.stringify(value)}`);
  }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`${label} must use printable ASCII for the pinned Blink argv bridge: ${JSON.stringify(value)}`);
  }
  return value;
}

function commandLine(executable: string, args: string[]): string {
  const tokens = [commandToken(executable, 'Tool executable'), ...args.map((arg, index) => commandToken(arg, `Tool argument ${index}`))];
  const line = tokens.join(' ');
  if (new TextEncoder().encode(line).length >= BLINK_ARG_BUFFER_BYTES) {
    throw new Error(`Tool command line exceeds the pinned Blink ${BLINK_ARG_BUFFER_BYTES - 1}-byte argv bridge limit.`);
  }
  return line;
}

function writeCString(memory: WebAssembly.Memory, address: number, value: string, maxLength = BLINK_ARG_BUFFER_BYTES): void {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length >= maxLength) throw new Error(`Blink bridge string exceeds ${maxLength - 1} bytes.`);
  const heap = new Uint8Array(memory.buffer);
  if (!address || address + encoded.length >= heap.byteLength) throw new Error('Blink bridge returned an invalid string buffer pointer.');
  heap.set(encoded, address);
  heap[address + encoded.length] = 0;
}

function clockMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function loadBlinkToolFactory(): Promise<{ factory: BlinkToolFactory; wasmUrl: string }> {
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  const jsUrl = new URL('vendor/blink/blinkenlib.js', base).href;
  const wasmUrl = new URL('vendor/blink/blinkenlib.wasm', base).href;
  const profileUrl = new URL('vendor/blink/build-profile.json', base).href;
  try {
    const response = await fetch(profileUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Blink build profile request failed with HTTP ${response.status}.`);
    const validation = validateBlinkBuildProfile(await response.json());
    if (!validation.ok) throw new Error(validation.reason ?? 'Blink build profile is incompatible.');
    const imported = await import(/* @vite-ignore */ jsUrl) as { default?: BlinkToolFactory };
    if (typeof imported.default !== 'function') throw new Error('vendored Blink module has no default Emscripten factory export.');
    return { factory: imported.default, wasmUrl };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Blink/WASM Tool Process assets are unavailable or incompatible (${detail}). Run \`bun run vendor:blink\` and rebuild.`);
  }
}

function copyToolFile(file: ToolFile, path: string): ToolFile {
  return { path, bytes: file.bytes.slice(), executable: file.executable };
}

export class BlinkToolProcessRunner implements ToolProcessRunner {
  private readonly toolchainFiles: ToolFile[];
  private readonly policy: BlinkToolProcessPolicy;
  private readonly runtime: BlinkToolRuntime;

  constructor(options: BlinkToolProcessRunnerOptions) {
    if (!options.toolchainFiles.length) throw new Error('Blink tool runner requires at least one explicit toolchain file.');
    const seen = new Set<string>();
    this.toolchainFiles = options.toolchainFiles.map((file) => {
      const path = requireNamespace(file.path, '/toolchain', 'Toolchain file');
      if (seen.has(path)) throw new Error(`Duplicate toolchain file path: ${path}`);
      seen.add(path);
      return copyToolFile(file, path);
    });
    this.policy = { ...DEFAULT_BLINK_TOOL_PROCESS_POLICY, ...(options.policy ?? {}) };
    this.runtime = options.runtime ?? DEFAULT_BLINK_TOOL_RUNTIME;
  }

  async run(request: ToolProcessRequest): Promise<ToolProcessResult> {
    if (request.env && Object.keys(request.env).length) {
      throw new Error('The pinned Blink browser bridge does not expose guest environment variables yet; ToolProcessRequest.env must be empty.');
    }

    const executable = requireNamespace(request.executable, '/toolchain', 'Tool executable');
    const executableFile = this.toolchainFiles.find((file) => file.path === executable);
    if (!executableFile || executableFile.executable !== true) {
      throw new Error(`Tool executable is not present as an explicit executable toolchain file: ${executable}`);
    }
    const cwd = requireNamespace(request.cwd, '/work', 'Tool working directory');
    const files = request.files.map((file) => copyToolFile(file, requireNamespace(file.path, '/work', 'Tool input file')));
    const captureFiles = request.captureFiles.map((path) => requireNamespace(path, '/work', 'Tool capture file'));
    const line = commandLine(executable, request.args);
    commandToken(cwd, 'Tool working directory');
    const mountedBytes = this.toolchainFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0)
      + files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (mountedBytes > this.policy.maxMountedBytes) {
      throw new Error(`Tool sandbox mount budget exceeded (${mountedBytes} > ${this.policy.maxMountedBytes} bytes).`);
    }

    const { factory, wasmUrl } = await this.runtime.loadFactory();
    const stdin = request.stdin?.slice() ?? new Uint8Array();
    let stdinCursor = 0;
    const stdoutBytes: number[] = [];
    const stderrBytes: number[] = [];
    let outputBytes = 0;
    let policyFailure: Error | null = null;
    let captureEnabled = false;
    let module!: BlinkToolModule;

    const appendOutput = (target: number[], byte: number) => {
      if (!captureEnabled) return;
      if (outputBytes >= this.policy.maxOutputBytes) {
        policyFailure ??= new Error(`Tool output budget exceeded (${this.policy.maxOutputBytes} bytes).`);
        return;
      }
      target.push(byte & 0xff);
      outputBytes += 1;
    };

    module = await factory({
      noInitialRun: true,
      locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path,
      print: () => {},
      printErr: () => {},
      preRun: (candidate: BlinkToolModule) => {
        candidate.FS.init(
          () => stdinCursor < stdin.length ? stdin[stdinCursor++] : null,
          (byte) => appendOutput(stdoutBytes, byte),
          (byte) => appendOutput(stderrBytes, byte)
        );
      }
    });

    let settled = false;
    let preemptions = 0;
    const started = clockMs();
    let resolveCompletion!: (result: ToolProcessResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ToolProcessResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectCompletion(error instanceof Error ? error : new Error(String(error)));
    };

    const checkPolicy = (): Error | null => {
      if (policyFailure) return policyFailure;
      const elapsed = clockMs() - started;
      if (elapsed > this.policy.maxRuntimeMs) return new Error(`Tool runtime budget exceeded (${Math.round(elapsed)}ms > ${this.policy.maxRuntimeMs}ms).`);
      if (preemptions > this.policy.maxPreemptions) return new Error(`Tool preemption budget exceeded (${preemptions} > ${this.policy.maxPreemptions}).`);
      return null;
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      const violation = checkPolicy();
      if (violation) { fail(violation); return; }
      try {
        const outputs: ToolFile[] = [];
        let capturedBytes = 0;
        for (const path of captureFiles) {
          try {
            const value = module.FS.readFile(path, { encoding: 'binary' });
            if (typeof value === 'string') throw new Error(`Blink FS returned text for binary capture ${path}.`);
            const bytes = new Uint8Array(value).slice();
            capturedBytes += bytes.byteLength;
            if (capturedBytes > this.policy.maxCapturedBytes) {
              throw new Error(`Tool captured-file budget exceeded (${capturedBytes} > ${this.policy.maxCapturedBytes} bytes).`);
            }
            outputs.push({ path, bytes });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (/no such file|ENOENT|not found/i.test(message)) continue;
            throw error;
          }
        }
        settled = true;
        const decoder = new TextDecoder();
        resolveCompletion({
          exitCode,
          stdout: decoder.decode(Uint8Array.from(stdoutBytes)),
          stderr: decoder.decode(Uint8Array.from(stderrBytes)),
          files: outputs
        });
      } catch (error: unknown) {
        fail(error);
      }
    };

    const signalPointer = module.addFunction((signal: number, code: number) => {
      if (settled) return;
      if (signal !== SIGTRAP) { finish(128 + signal); return; }
      if (code === BLINK_PREEMPT) {
        preemptions += 1;
        const violation = checkPolicy();
        if (violation) { fail(violation); return; }
        setTimeout(() => {
          if (settled) return;
          try { module._blinkenlib_preempt_resume(); }
          catch (error: unknown) { fail(error); }
        }, 0);
        return;
      }
      if (code === BLINK_FAKE_TTY) {
        fail(new Error('Tool process requested interactive TTY input; only preloaded stdin is supported.'));
        return;
      }
      fail(new Error(`Tool process stopped on unsupported Blink SIGTRAP code ${code}.`));
    }, 'vii');
    const exitPointer = module.addFunction((code: number) => finish(code), 'vi');

    try {
      module.callMain([String(signalPointer), String(exitPointer)]);
      const fs = module.FS;
      const allFiles = [...this.toolchainFiles, ...files];
      for (const file of allFiles) {
        fs.mkdirTree(parentPath(file.path));
        fs.writeFile(file.path, file.bytes);
        fs.chmod(file.path, file.executable ? 0o555 : 0o644);
      }
      for (const path of captureFiles) fs.mkdirTree(parentPath(path));
      fs.mkdirTree(cwd);
      fs.chdir(cwd);

      writeCString(module.wasmExports.memory, module._blinkenlib_get_progname_string(), executable);
      writeCString(module.wasmExports.memory, module._blinkenlib_get_argc_string(), line);
      writeCString(module.wasmExports.memory, module._blinkenlib_get_argv_string(), '');
      captureEnabled = true;
      module._blinkenlib_run_fast();
    } catch (error: unknown) {
      fail(error);
    }

    return completion;
  }
}
