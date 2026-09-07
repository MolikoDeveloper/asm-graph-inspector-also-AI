import type { BlinkIsaAudit, BlinkIsaEvidence } from '../../src/features/execution/blinkIsaPreflight';
import {
  auditBlinkRuntimeDependencyIsa,
  describeBlinkRuntimeIsaAdvisory,
  describeBlinkRuntimeIsaFailure
} from '../../src/features/execution/runtimeIsaAudit';
import type { MaterializedRuntimeModule, RuntimeDependencyClosure } from '../../src/features/execution/runtimeDependencies';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function module(requestedName: string, fileName = requestedName, soname: string | null = requestedName): MaterializedRuntimeModule {
  return {
    requestedName,
    fileName,
    soname,
    bytes: new ArrayBuffer(32),
    neededLibraries: [],
    sourceId: `fixture:${fileName}`,
    sourceKind: 'file',
    sourceName: fileName
  };
}

const loader = module('ld-linux-x86-64.so.2');
const libc = module('libc.so.6');
const libm = module('libm.so.6');
const closure: RuntimeDependencyClosure = {
  interpreterPath: '/lib64/ld-linux-x86-64.so.2',
  modules: [loader, libc, libm],
  totalBytes: 96
};

function evidence(address: number, mnemonic: string, family: 'avx-family' | 'gfni' = 'avx-family'): BlinkIsaEvidence {
  return {
    family,
    address,
    mnemonic,
    operands: 'ymm0, ymm1',
    bytes: [0xc5, 0xfc, 0x10, 0xc1],
    sectionName: 'PT_LOAD#1'
  };
}

function auditFor(name: string): BlinkIsaAudit {
  const unsupported = name === 'libc.so.6'
    ? [evidence(0x12340, 'vmovups'), evidence(0x12700, 'vgf2p8affineqb', 'gfni')]
    : name === 'ld-linux-x86-64.so.2'
      ? [evidence(0x2f000, 'vmovups')]
      : [];
  return {
    compatible: unsupported.length === 0,
    profile: 'asm-graph-inspector-linux-x86-64-baseline-v1',
    scannedInstructions: 100,
    decodedBytes: 400,
    skippedBytes: 0,
    unsupportedFamilies: [...new Set(unsupported.map((item) => item.family))],
    evidence: unsupported
  };
}

const tolerant = await auditBlinkRuntimeDependencyIsa(closure, {
  auditModule: async (runtimeModule) => auditFor(runtimeModule.fileName),
  auditInterpreterEntry: async () => null
});

assert(tolerant.compatible, 'optional whole-image ISA in loader/libc must not block runtime preparation');
assert(tolerant.scannedModules === 3, 'all materialized runtime modules must be inventoried');
assert(tolerant.advisoryModuleCount === 2, 'loader/libc unsupported static evidence should be recorded as advisory');
assert(tolerant.blockingModuleCount === 0, 'dispatch-tolerant inventory should have no blocker without mandatory entry evidence');
assert(tolerant.modules.find((item) => item.fileName === 'libc.so.6')?.unsupportedFamilies.includes('gfni'), 'libc GFNI inventory should be retained');
const advisory = describeBlinkRuntimeIsaAdvisory(tolerant);
assert(advisory?.includes('libc.so.6'), 'advisory diagnostic should name the concrete runtime module');
assert(advisory?.includes('GNU IFUNC'), 'advisory diagnostic should explain why whole-image hits are non-blocking');

const loaderEntry = evidence(0x1a8e0, 'vbroadcastss');
const blocked = await auditBlinkRuntimeDependencyIsa(closure, {
  auditModule: async (runtimeModule) => auditFor(runtimeModule.fileName),
  auditInterpreterEntry: async (runtimeModule) => runtimeModule.fileName === 'ld-linux-x86-64.so.2' ? loaderEntry : null
});

assert(!blocked.compatible, 'unsupported mandatory PT_INTERP entry instruction must block');
assert(blocked.blockingModuleCount === 1, 'exactly the interpreter entry should be blocking');
assert(blocked.modules.find((item) => item.role === 'interpreter')?.blockingEvidence?.address === loaderEntry.address, 'blocking evidence must retain exact interpreter entry address');
const failure = describeBlinkRuntimeIsaFailure(blocked);
assert(failure.includes('ld-linux-x86-64.so.2'), 'failure should name selected interpreter');
assert(failure.includes('0x1a8e0'), 'failure should expose exact mandatory entry address');
assert(failure.includes('mandatory interpreter-entry evidence'), 'failure must distinguish blocker from optional DSO inventory');

const dependencyEntryIgnored = await auditBlinkRuntimeDependencyIsa(closure, {
  auditModule: async (runtimeModule) => auditFor(runtimeModule.fileName),
  auditInterpreterEntry: async (runtimeModule) => runtimeModule.fileName === 'libc.so.6' ? evidence(0x12340, 'vmovups') : null
});
assert(dependencyEntryIgnored.compatible, 'dependency ELF entry is not a mandatory process path and must not become a false blocker');

console.log('runtime ISA audit smoke: PASS (full closure inventory + IFUNC-safe advisory policy + mandatory interpreter-entry blocker)');
