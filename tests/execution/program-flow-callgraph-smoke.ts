import { buildProgramFlow } from '../../src/features/analysis/programFlow';
import type { BinaryAnalysisSummary, BinaryFunctionCandidate, BinaryProgramTransfer } from '../../src/features/binary/model';

function fn(address: number, name: string): BinaryFunctionCandidate {
  return {
    address,
    endAddress: address + 16,
    size: 16,
    name,
    sectionIndex: 1,
    sectionName: '.text',
    kind: 'symbol',
    confidence: 'exact',
    evidence: 'test symbol',
    symbol: null,
    unwindFde: null,
    leadingPaddingBytes: 0
  };
}

const functions = [fn(0x1000, '_start'), fn(0x1100, 'main'), fn(0x1200, 'worker')];
const transfers: BinaryProgramTransfer[] = [
  { fromAddress: 0x1000, toAddress: 0x1100, kind: 'startup', callsiteAddress: 0x1008, evidence: 'startup handoff' },
  { fromAddress: 0x1100, toAddress: 0x1200, kind: 'call', callsiteAddress: 0x1104, evidence: 'direct call' }
];
const summary = {
  rootAddress: 0x1100,
  rootName: 'main',
  instructions: [],
  functions,
  pltStubs: [],
  programTransfers: transfers,
  programDiagnostics: []
} as unknown as BinaryAnalysisSummary;

const model = buildProgramFlow({
  fileId: 'fixture',
  functions,
  pltStubs: [],
  summaries: [summary],
  staticTransfers: transfers,
  entryAddress: 0x1000,
  activeAddress: 0x1100,
  scope: 'visited',
  hiddenGroups: new Set(),
  expandedGroups: new Set()
});

const titles = new Set(model.graph.nodes.map((node) => node.title));
if (!titles.has('_start') || !titles.has('main') || !titles.has('worker')) throw new Error(`Expected function nodes, got: ${[...titles].join(', ')}`);
if (titles.has('(root)')) throw new Error('Connected-call scope must not collapse functions into a root namespace node.');
if (model.graph.edges.length !== 2) throw new Error(`Expected 2 interprocedural edges, got ${model.graph.edges.length}.`);
if (!model.graph.edges.some((edge) => edge.label === 'libc startup → main')) throw new Error('Expected startup handoff edge.');

console.log('program flow call graph smoke: PASS (function nodes + connected calls, no compact root node)');
