import type { ElfSymbolVersionSummary } from '../../src/features/binary/elfSymbolVersions';
import type { RuntimeDependencyClosure, MaterializedRuntimeModule } from '../../src/features/execution/runtimeDependencies';
import {
  describeRuntimeSymbolVersionFailure,
  validateRuntimeSymbolVersions
} from '../../src/features/execution/runtimeSymbolVersions';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function module(requestedName: string, fileName: string, soname: string | null, bytes: ArrayBuffer): MaterializedRuntimeModule {
  return {
    requestedName,
    fileName,
    soname,
    bytes,
    neededLibraries: [],
    sourceId: `fixture:${fileName}`,
    sourceKind: 'file',
    sourceName: fileName
  };
}

const root = new ArrayBuffer(1);
const libc = new ArrayBuffer(2);
const loader = new ArrayBuffer(3);
const summaries = new Map<ArrayBuffer, ElfSymbolVersionSummary>([
  [root, {
    requirements: [
      { library: 'libc.so.6', versions: ['GLIBC_2.34', 'GLIBC_2.36'] },
      { library: 'ld-linux-x86-64.so.2', versions: ['GLIBC_2.2.5'] }
    ],
    definitions: []
  }],
  [libc, { requirements: [], definitions: ['libc.so.6', 'GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_2.36'] }],
  [loader, { requirements: [], definitions: ['ld-linux-x86-64.so.2', 'GLIBC_2.2.5'] }]
]);
const inspect = (bytes: ArrayBuffer) => {
  const summary = summaries.get(bytes);
  if (!summary) throw new Error('unknown synthetic ELF');
  return summary;
};

const closure: RuntimeDependencyClosure = {
  interpreterPath: '/lib64/ld-linux-x86-64.so.2',
  modules: [
    module('ld-linux-x86-64.so.2', 'ld-linux-x86-64.so.2', 'ld-linux-x86-64.so.2', loader),
    module('libc.so.6', 'libc.so.6', 'libc.so.6', libc)
  ],
  totalBytes: 5
};

const compatible = validateRuntimeSymbolVersions('guest', root, closure, inspect);
assert(compatible.compatible, describeRuntimeSymbolVersionFailure(compatible));
assert(compatible.checkedRequirements === 3, `expected three checked version requirements, got ${compatible.checkedRequirements}`);

summaries.set(libc, { requirements: [], definitions: ['libc.so.6', 'GLIBC_2.2.5', 'GLIBC_2.34'] });
const oldLibc = validateRuntimeSymbolVersions('guest', root, closure, inspect);
assert(!oldLibc.compatible, 'old libc must fail the requested GLIBC_2.36 contract');
assert(oldLibc.issues.length === 1, `expected one version mismatch, got ${oldLibc.issues.length}`);
assert(oldLibc.issues[0].kind === 'version-missing', `unexpected issue kind ${oldLibc.issues[0].kind}`);
assert(oldLibc.issues[0].library === 'libc.so.6', 'mismatch should name libc.so.6');
assert(oldLibc.issues[0].version === 'GLIBC_2.36', 'mismatch should name GLIBC_2.36');
assert(oldLibc.issues[0].provider === 'libc.so.6', 'mismatch should name the selected provider');
const failure = describeRuntimeSymbolVersionFailure(oldLibc);
assert(failure.includes('guest requires libc.so.6@GLIBC_2.36'), 'failure should name the requester/library/version tuple');
assert(failure.includes('selected libc.so.6 does not define GLIBC_2.36'), 'failure should explain the exact provider deficiency');

summaries.set(root, { requirements: [{ library: 'libm.so.6', versions: ['GLIBC_2.29'] }], definitions: [] });
const unresolved = validateRuntimeSymbolVersions('guest', root, closure, inspect);
assert(!unresolved.compatible, 'missing selected provider must fail');
assert(unresolved.issues[0]?.kind === 'provider-unresolved', 'missing provider should be classified explicitly');
assert(describeRuntimeSymbolVersionFailure(unresolved).includes('no selected Global Dependency provides libm.so.6'), 'missing provider diagnostic should tell the user what to add');

console.log('runtime symbol-version compatibility smoke: PASS');
