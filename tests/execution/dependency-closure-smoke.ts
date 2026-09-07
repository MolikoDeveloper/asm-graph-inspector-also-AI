import { resolveGlobalDependencyClosureFromEntries } from '../../src/features/dependencies/globalDependencyResolver';
import type { GlobalDependencyFile } from '../../src/features/dependencies/model';

function library(id: string, name: string, neededLibraries: string[]): GlobalDependencyFile {
  return {
    schema: 'asm-graph.global-dependency/v1',
    id,
    kind: 'file',
    name,
    soname: name,
    neededLibraries,
    size: 1,
    bytes: new ArrayBuffer(1),
    addedAt: 0,
    updatedAt: 0
  };
}

const entries = [
  library('ld', 'ld-linux-x86-64.so.2', []),
  library('libc', 'libc.so.6', ['ld-linux-x86-64.so.2']),
  library('libm', 'libm.so.6', ['libc.so.6', 'ld-linux-x86-64.so.2'])
];

async function main() {
  const closure = await resolveGlobalDependencyClosureFromEntries(entries, '/lib64/ld-linux-x86-64.so.2', ['libm.so.6']);
const names = closure.map((dependency) => dependency.requestedName);
if (names.join(',') !== 'ld-linux-x86-64.so.2,libm.so.6,libc.so.6') throw new Error(`Unexpected dependency closure: ${names.join(', ')}`);
const libc = closure.find((dependency) => dependency.requestedName === 'libc.so.6');
if (!libc || libc.role !== 'transitive' || libc.depth !== 1 || libc.requestedBy !== 'libm.so.6') throw new Error('libc.so.6 should be a depth-1 transitive dependency of libm.so.6.');
if (closure.filter((dependency) => dependency.requestedName === 'ld-linux-x86-64.so.2').length !== 1) throw new Error('Interpreter must be deduplicated when a DT_NEEDED closure references it again.');

  console.log('dependency closure smoke: PASS (PT_INTERP + recursive DT_NEEDED + dedupe)');
}

void main();
