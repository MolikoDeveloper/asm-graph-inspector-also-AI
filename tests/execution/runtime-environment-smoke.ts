import type { LoadedImage } from '../../src/features/binary/model';
import type { ProjectFile } from '../../src/features/project/model';
import {
  BlinkProcessSession,
  type BlinkModule,
  type BlinkProcessRuntime
} from '../../src/features/execution/blinkProcessSession';
import { DEFAULT_EXECUTION_POLICY } from '../../src/features/execution/model';
import {
  BLINK_RUNTIME_ENVIRONMENT_SCHEMA,
  prepareBlinkRuntimeEnvironment
} from '../../src/features/execution/runtimeEnvironment';
import type { RuntimeDependencyClosure } from '../../src/features/execution/runtimeDependencies';
import type { BlinkRuntimeIsaAudit } from '../../src/features/execution/runtimeIsaAudit';
import type { RuntimeSymbolVersionValidation } from '../../src/features/execution/runtimeSymbolVersions';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const bytes = new Uint8Array(128).buffer;
const file: ProjectFile = {
  id: 'runtime-env-fixture',
  path: 'runtime-env-fixture',
  name: 'runtime-env-fixture',
  kind: 'binary',
  language: 'binary',
  bytes,
  size: bytes.byteLength,
  updatedAt: 7
};
const image = {
  schema: 'asm-graph.loaded-image/v1',
  sourceFileId: file.id,
  sourcePath: file.path,
  architecture: 'x86-64',
  byteOrder: 'little',
  kind: 'executable',
  entry: 0x401000,
  buildId: null,
  soname: null,
  neededLibraries: [],
  interpreter: null,
  segments: [],
  sections: [],
  symbols: [],
  relocations: [],
  functions: [],
  unwind: { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 }
} as LoadedImage;

const closure: RuntimeDependencyClosure = {
  interpreterPath: null,
  modules: [],
  totalBytes: 0
};
const versions: RuntimeSymbolVersionValidation = {
  compatible: true,
  requesterCount: 1,
  checkedRequirements: 0,
  issues: []
};
const runtimeIsa: BlinkRuntimeIsaAudit = {
  compatible: true,
  scannedModules: 0,
  scannedInstructions: 0,
  decodedBytes: 0,
  skippedBytes: 0,
  advisoryModuleCount: 0,
  blockingModuleCount: 0,
  modules: []
};

let preparationMaterializations = 0;
let versionValidations = 0;
let runtimeIsaAudits = 0;
const prepared = await prepareBlinkRuntimeEnvironment(file, image, {
  materialize: async (interpreterPath, directNeeded) => {
    preparationMaterializations += 1;
    assert(interpreterPath === null, 'fixture should not request PT_INTERP');
    assert(directNeeded.length === 0, 'fixture should not request DT_NEEDED libraries');
    return closure;
  },
  validateSymbolVersions: (rootName, rootBytes, selectedClosure) => {
    versionValidations += 1;
    assert(rootName === file.name, 'symbol-version validator should receive root artifact name');
    assert(rootBytes === file.bytes, 'symbol-version validator should inspect authoritative root bytes');
    assert(selectedClosure === closure, 'symbol-version validator must receive the exact materialized closure');
    return versions;
  },
  auditRuntimeIsa: async (selectedClosure) => {
    runtimeIsaAudits += 1;
    assert(selectedClosure === closure, 'runtime ISA audit must receive the exact materialized closure');
    return runtimeIsa;
  }
});

assert(prepared.schema === BLINK_RUNTIME_ENVIRONMENT_SCHEMA, 'prepared environment schema mismatch');
assert(prepared.closure === closure, 'prepared environment must retain exact closure identity');
assert(prepared.symbolVersions === versions, 'prepared environment must retain exact symbol-version evidence');
assert(prepared.runtimeIsa === runtimeIsa, 'prepared environment must retain exact runtime ISA evidence');
assert(preparationMaterializations === 1, `runtime preparation must materialize once, got ${preparationMaterializations}`);
assert(versionValidations === 1, `runtime preparation must validate symbol versions once, got ${versionValidations}`);
assert(runtimeIsaAudits === 1, `runtime preparation must audit runtime ISA once, got ${runtimeIsaAudits}`);

class MinimalBlinkModule implements BlinkModule {
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

  private nextCallback = 1;
  addFunction(_callback: (...args: number[]) => void, _signature: string): number { return this.nextCallback++; }
  callMain(_args: string[]): void {}
  _blinkenlib_get_clstruct(): number { return 0; }
  _blinkenlib_get_argc_string(): number { return 256; }
  _blinkenlib_get_argv_string(): number { return 512; }
  _blinkenlib_get_progname_string(): number { return 768; }
  _blinkenlib_run_fast(): void {}
  _blinkenlib_starti(): void {}
  _blinkenlib_stepi(): void {}
  _blinkenlib_continue(): void {}
  _blinkenlib_preempt_resume(): void {}
}

function runtime(materialize: BlinkProcessRuntime['materialize']): BlinkProcessRuntime {
  return {
    materialize,
    async loadFactory() {
      return {
        wasmUrl: 'memory://blinkenlib.wasm',
        factory: async (options) => {
          const module = new MinimalBlinkModule();
          const preRun = options.preRun as ((candidate: BlinkModule) => void) | undefined;
          preRun?.(module);
          return module;
        }
      };
    }
  };
}

let forbiddenSessionMaterializations = 0;
const preparedSession = await BlinkProcessSession.create(
  file,
  image,
  DEFAULT_EXECUTION_POLICY,
  runtime(async () => {
    forbiddenSessionMaterializations += 1;
    throw new Error('BlinkProcessSession rematerialized a prepared runtime closure');
  }),
  prepared
);
preparedSession.dispose();
assert(
  forbiddenSessionMaterializations === 0,
  `prepared Blink session must not rematerialize Global Dependencies, got ${forbiddenSessionMaterializations} call(s)`
);
assert(runtimeIsaAudits === 1, 'BlinkProcessSession must reuse prepared runtime ISA evidence instead of rescanning runtime modules');

let fallbackMaterializations = 0;
const fallbackSession = await BlinkProcessSession.create(
  file,
  image,
  DEFAULT_EXECUTION_POLICY,
  runtime(async () => {
    fallbackMaterializations += 1;
    return closure;
  })
);
fallbackSession.dispose();
assert(fallbackMaterializations === 1, `unprepared direct session should materialize exactly once, got ${fallbackMaterializations}`);

let staleRejected = false;
try {
  await BlinkProcessSession.create(
    { ...file, updatedAt: file.updatedAt + 1 },
    image,
    DEFAULT_EXECUTION_POLICY,
    runtime(async () => closure),
    prepared
  );
} catch (error: unknown) {
  staleRejected = error instanceof Error && error.message.includes('stale');
}
assert(staleRejected, 'prepared runtime environment must fail closed after the binary artifact changes');

console.log('runtime environment smoke: PASS (prepare once -> validate/audit exact closure once -> Blink reuses exact closure/evidence -> stale reuse rejected)');
