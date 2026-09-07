import type { LoadedImage } from '../../src/features/binary/model';
import type { ProjectFile } from '../../src/features/project/model';
import type { BlinkIsaAudit } from '../../src/features/execution/blinkIsaPreflight';
import {
  ARTIFACT_COMPATIBILITY_REPORT_SCHEMA,
  buildArtifactCompatibilityReport
} from '../../src/features/execution/artifactCompatibilityReport';
import type { ExecutionSnapshot, ExecutionSupport } from '../../src/features/execution/model';
import type { RuntimeDependencyClosure, MaterializedRuntimeModule } from '../../src/features/execution/runtimeDependencies';
import type { RuntimeSymbolVersionValidation } from '../../src/features/execution/runtimeSymbolVersions';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function elf64ExecutableBytes(): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 62, true); // EM_X86_64
  view.setBigUint64(24, 0x401000n, true);
  return bytes.buffer;
}

const bytes = elf64ExecutableBytes();
const file: ProjectFile = {
  id: 'artifact-fixture', path: 'artifact-fixture', name: 'artifact-fixture',
  kind: 'binary', language: 'binary', bytes, size: bytes.byteLength, updatedAt: 1
};
const image = {
  schema: 'asm-graph.loaded-image/v1', sourceFileId: file.id, sourcePath: file.path,
  architecture: 'x86-64', byteOrder: 'little', kind: 'executable', entry: 0x401000,
  buildId: null, soname: null, neededLibraries: ['libc.so.6'], interpreter: '/lib64/ld-linux-x86-64.so.2',
  segments: [], sections: [], symbols: [], relocations: [], functions: [],
  unwind: { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 }
} as LoadedImage;
const support: ExecutionSupport = {
  supported: true,
  provider: 'blink-process',
  reasons: [],
  notes: ['dynamic Linux userspace process']
};
const compatibleIsa: BlinkIsaAudit = {
  compatible: true,
  profile: 'asm-graph-inspector-linux-x86-64-baseline-v1',
  scannedInstructions: 12,
  decodedBytes: 48,
  skippedBytes: 0,
  unsupportedFamilies: [],
  evidence: []
};
const loaderBytes = new ArrayBuffer(2);
const libcBytes = new ArrayBuffer(3);
function runtimeModule(requestedName: string, fileName: string, soname: string | null, moduleBytes: ArrayBuffer): MaterializedRuntimeModule {
  return {
    requestedName, fileName, soname, bytes: moduleBytes, neededLibraries: [],
    sourceId: `fixture:${fileName}`, sourceKind: 'file', sourceName: fileName
  };
}
const closure: RuntimeDependencyClosure = {
  interpreterPath: '/lib64/ld-linux-x86-64.so.2',
  modules: [
    runtimeModule('ld-linux-x86-64.so.2', 'ld-linux-x86-64.so.2', 'ld-linux-x86-64.so.2', loaderBytes),
    runtimeModule('libc.so.6', 'libc.so.6', 'libc.so.6', libcBytes)
  ],
  totalBytes: 5
};
const symbolVersions: RuntimeSymbolVersionValidation = {
  compatible: true,
  requesterCount: 3,
  checkedRequirements: 2,
  issues: []
};

const preRun = buildArtifactCompatibilityReport({
  file, image, executionSupport: support, isaAudit: compatibleIsa,
  runtimeClosure: closure, symbolVersions
});
assert(preRun.schema === ARTIFACT_COMPATIBILITY_REPORT_SCHEMA, 'report schema mismatch');
assert(preRun.compatible === null, 'pre-run report must remain incomplete while observed runtime checks are unknown');
assert(preRun.blockerIds.length === 0, 'pre-run compatible evidence should have no blockers');
assert(preRun.checks.find((item) => item.id === 'elf-format')?.status === 'pass', 'ELF64 little-endian should pass');
assert(preRun.checks.find((item) => item.id === 'architecture')?.status === 'pass', 'x86-64 should pass');
assert(preRun.checks.find((item) => item.id === 'interpreter')?.status === 'pass', 'selected interpreter should pass');
assert(preRun.checks.find((item) => item.id === 'dependency-closure')?.status === 'pass', 'resolved closure should pass');
assert(preRun.checks.find((item) => item.id === 'symbol-versions')?.status === 'pass', 'symbol versions should pass');

const exited: ExecutionSnapshot = {
  status: 'exited', targetFileId: file.id, targetName: file.name, imageKind: 'executable', provider: 'blink-process',
  instructionCount: 0, registers: null, lastInstruction: null, runtimeDisassembly: null,
  stdout: '', stderr: '', exitCode: 7, trapReason: null, crash: null, providerDiagnostics: [], events: []
};
const completed = buildArtifactCompatibilityReport({
  file, image, executionSupport: support, isaAudit: compatibleIsa,
  runtimeClosure: closure, symbolVersions, snapshot: exited
});
assert(completed.compatible === true, 'clean observed provider exit should complete compatibility evidence even with an application nonzero exit');
assert(completed.checks.find((item) => item.id === 'observed-runtime')?.status === 'pass', 'application exit should not be classified as sandbox incompatibility');
assert(completed.checks.find((item) => item.id === 'runtime-services')?.status === 'pass', 'completed run without unsupported service diagnostic should pass observed services');

const badIsa: BlinkIsaAudit = {
  ...compatibleIsa,
  compatible: false,
  unsupportedFamilies: ['avx-family'],
  evidence: [{ family: 'avx-family', address: 0x401020, mnemonic: 'vbroadcastss', operands: 'ymm0, [rip]', bytes: [0xc4, 0xe2, 0x7d, 0x18, 0x05], sectionName: 'PT_LOAD#2' }]
};
const isaBlocked = buildArtifactCompatibilityReport({
  file, image, executionSupport: support, isaAudit: badIsa,
  runtimeClosure: closure, symbolVersions
});
assert(isaBlocked.compatible === false, 'unsupported executable ISA must block compatibility');
assert(isaBlocked.blockerIds.includes('cpu-isa'), 'ISA blocker must be structured');

const versionBlocked: RuntimeSymbolVersionValidation = {
  compatible: false,
  requesterCount: 3,
  checkedRequirements: 2,
  issues: [{
    kind: 'version-missing', requester: file.name, library: 'libc.so.6', version: 'GLIBC_2.36', provider: 'libc.so.6',
    detail: `${file.name} requires libc.so.6@GLIBC_2.36, but selected libc.so.6 does not define GLIBC_2.36.`
  }]
};
const versionReport = buildArtifactCompatibilityReport({
  file, image, executionSupport: support, isaAudit: compatibleIsa,
  runtimeClosure: closure, symbolVersions: versionBlocked
});
assert(versionReport.compatible === false, 'missing GNU symbol version must block compatibility');
assert(versionReport.blockerIds.includes('symbol-versions'), 'symbol-version blocker must be structured');
assert(versionReport.checks.find((item) => item.id === 'symbol-versions')?.evidence[0]?.includes('GLIBC_2.36'), 'report should expose exact missing GNU version');

const crashed: ExecutionSnapshot = {
  ...exited,
  status: 'trapped', exitCode: 132,
  crash: {
    signal: 4, signalName: 'SIGILL', signalCode: 2, exitCode: 132,
    runtimeAddress: 0x49c038n, imageName: file.name, imageRole: 'program', imageAddress: 0x49c038n, loadBias: 0n,
    functionName: 'lifecycle.create', functionOffset: 0xc8, codeBytes: [0xc4, 0xe2, 0x7d, 0x18, 0x05],
    instruction: { address: 0x49c038, endAddress: 0x49c041, bytes: [0xc4, 0xe2, 0x7d, 0x18, 0x05], mnemonic: 'vbroadcastss', operands: 'ymm0, [rip]' },
    isaFamily: 'avx-family', evidence: 'blink-headless-signal-clstruct'
  },
  trapReason: 'observed SIGILL'
};
const crashReport = buildArtifactCompatibilityReport({
  file, image, executionSupport: support, isaAudit: badIsa,
  runtimeClosure: closure, symbolVersions, snapshot: crashed
});
assert(crashReport.blockerIds.includes('observed-runtime'), 'observed fatal signal must be a structured blocker');
assert(crashReport.checks.find((item) => item.id === 'observed-runtime')?.summary.includes('RIP 0x49c038'), 'runtime blocker must name observed RIP');

const unsupportedService: ExecutionSnapshot = {
  ...exited,
  providerDiagnostics: [{ level: 'warning', message: 'unsupported syscall: __syscall_clone3', count: 1 }]
};
const serviceReport = buildArtifactCompatibilityReport({
  file, image, executionSupport: support, isaAudit: compatibleIsa,
  runtimeClosure: closure, symbolVersions, snapshot: unsupportedService
});
assert(serviceReport.compatible === false, 'observed unsupported syscall must block the report');
assert(serviceReport.blockerIds.includes('runtime-services'), 'unsupported runtime service must be a structured blocker');

assert(!JSON.stringify(completed).match(/zig|vzed|gcc|clang|rust|nasm/i), 'core compatibility report must not infer or encode producer identity');
console.log('artifact compatibility report smoke: PASS (ELF/ISA/deps/symbol versions/runtime, producer agnostic)');
