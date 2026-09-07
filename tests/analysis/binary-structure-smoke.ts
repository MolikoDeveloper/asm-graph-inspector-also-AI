import assert from 'node:assert/strict';
import { buildBinaryStructureGraph } from '../../src/features/analysis/binaryStructureGraph';
import { layoutGraph } from '../../src/features/analysis/layout';
import type { BinaryAnalysisSummary } from '../../src/features/binary/model';

const summary: BinaryAnalysisSummary = {
  image: {
    schema: 'asm-graph.loaded-image/v1',
    sourceFileId: 'fixture-bin',
    sourcePath: 'build/fixture',
    architecture: 'x86-64',
    byteOrder: 'little',
    kind: 'executable',
    entry: 0x401000,
    buildId: '00112233',
    soname: null,
    neededLibraries: ['libc.so.6'],
    interpreter: '/lib64/ld-linux-x86-64.so.2',
    segments: [
      { index: 2, type: 1, flags: 4, offset: 0, virtualAddress: 0x400000, fileSize: 0x1000, memorySize: 0x1000, alignment: 0x1000, readable: true, writable: false, executable: false },
      { index: 3, type: 1, flags: 5, offset: 0x1000, virtualAddress: 0x401000, fileSize: 0x800, memorySize: 0x800, alignment: 0x1000, readable: true, writable: false, executable: true },
      { index: 4, type: 1, flags: 6, offset: 0x2000, virtualAddress: 0x402000, fileSize: 0x400, memorySize: 0x600, alignment: 0x1000, readable: true, writable: true, executable: false }
    ],
    sections: [
      { index: 1, name: '.text', type: 1, flags: 6, address: 0x401000, offset: 0x1000, size: 0x500, link: 0, info: 0, alignment: 16, entrySize: 0, executable: true, writable: false, allocated: true },
      { index: 2, name: '.rodata', type: 1, flags: 2, address: 0x401500, offset: 0x1500, size: 0x100, link: 0, info: 0, alignment: 8, entrySize: 0, executable: false, writable: false, allocated: true },
      { index: 3, name: '.data', type: 1, flags: 3, address: 0x402000, offset: 0x2000, size: 0x80, link: 0, info: 0, alignment: 8, entrySize: 0, executable: false, writable: true, allocated: true },
      { index: 4, name: '.symtab', type: 2, flags: 0, address: 0, offset: 0x2400, size: 0x180, link: 5, info: 0, alignment: 8, entrySize: 24, executable: false, writable: false, allocated: false }
    ],
    symbols: [],
    relocations: [{ sectionIndex: 6, sectionName: '.rela.plt', offset: 0x402100, type: 7, symbolIndex: 1, symbolName: 'puts', addend: 0 }],
    functions: [],
    unwind: { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 }
  },
  rootName: '_start',
  rootAddress: 0x401000,
  rootSize: 32,
  instructions: [],
  functions: [
    { address: 0x401000, endAddress: 0x401020, size: 32, name: '_start', sectionIndex: 1, sectionName: '.text', kind: 'entrypoint', confidence: 'exact', evidence: 'fixture', symbol: null, unwindFde: null, leadingPaddingBytes: 0 },
    { address: 0x401020, endAddress: 0x401040, size: 32, name: 'main', sectionIndex: 1, sectionName: '.text', kind: 'symbol', confidence: 'exact', evidence: 'fixture', symbol: null, unwindFde: null, leadingPaddingBytes: 0 }
  ],
  pltStubs: [],
  dependencies: [
    { requestedName: 'ld-linux-x86-64.so.2', status: 'resolved', sourceId: 'ld', sourceKind: 'file', sourceName: 'ld-linux-x86-64.so.2', fileName: 'ld-linux-x86-64.so.2', soname: 'ld-linux-x86-64.so.2', evidence: 'fixture', role: 'interpreter', depth: 0, requestedBy: null, neededLibraries: [] },
    { requestedName: 'libc.so.6', status: 'resolved', sourceId: 'libc', sourceKind: 'file', sourceName: 'libc.so.6', fileName: 'libc.so.6', soname: 'libc.so.6', evidence: 'fixture', role: 'direct', depth: 0, requestedBy: 'fixture', neededLibraries: [] }
  ],
  programTransfers: [],
  programDiagnostics: []
};

const graph = buildBinaryStructureGraph(summary);
assert.equal(graph.viewKind, 'binary-structure');
assert.ok(graph.nodes.length > 12, `expected a real structure graph, got ${graph.nodes.length} node(s)`);
assert.ok(graph.nodes.some((node) => node.category === 'BINARY ARTIFACT'));
assert.ok(graph.nodes.some((node) => node.title === 'PT_LOAD #3' && node.address === 0x401000));
assert.ok(graph.nodes.some((node) => node.title === '.text'));
assert.ok(graph.nodes.some((node) => node.title === 'libc.so.6'));
assert.ok(graph.nodes.some((node) => node.title === '_start'));
assert.ok(graph.edges.length >= graph.nodes.length - 2);

const positioned = layoutGraph(graph);
assert.equal(positioned.length, graph.nodes.length);
assert.ok(positioned.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && node.width > 0 && node.height > 0));
assert.ok(new Set(positioned.map((node) => node.y)).size > 2, 'structure layout must use multiple visual layers');

console.log(`binary structure smoke passed · ${graph.nodes.length} nodes · ${graph.edges.length} edges`);
