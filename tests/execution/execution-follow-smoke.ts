import type { AnalysisGraph } from '../../src/features/analysis/model';
import type { BinaryAnalysisSummary, CanonicalInstruction } from '../../src/features/binary/model';
import type { ExecutionSnapshot } from '../../src/features/execution/model';
import {
  executionAddressFromSnapshot,
  findBinaryFunctionForAddress,
  graphNodeForAddress,
  imageContainsExecutableAddress
} from '../../src/features/execution/follow';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function instruction(address: number, endAddress = address + 4): CanonicalInstruction {
  return {
    schema: 'asm-graph.decoded-instruction/v1',
    address,
    endAddress,
    size: endAddress - address,
    bytes: [],
    id: 0,
    mnemonic: 'nop',
    operands: '',
    operandDetails: [],
    memoryOperands: [],
    explicitRegisterReads: [],
    explicitRegisterWrites: [],
    registerReads: [],
    registerWrites: [],
    groups: [],
    controlFlow: 'none',
    directTarget: null,
    decoderDetail: { prefix: [], opcode: [], rex: 0, addressSize: 64, modrm: 0, sib: 0, displacement: 0, eflags: 0, evidence: 'pinned-capstone-5.0.9-wasm32-layout' },
    evidence: 'capstone-x86-5.0.9'
  };
}

const graph: AnalysisGraph = {
  fileId: 'ray-test',
  nodes: [
    { id: 'bb-entry', line: 0, address: 0x406820, title: 'entry', detail: '', kind: 'instruction', blockInstructions: [instruction(0x406820, 0x406824), instruction(0x406824, 0x406828)] },
    { id: 'bb-next', line: 0, address: 0x406828, title: 'next', detail: '', kind: 'branch', blockInstructions: [instruction(0x406828, 0x40682c)] }
  ],
  edges: [{ id: 'e', from: 'bb-entry', to: 'bb-next', kind: 'control', label: 'fallthrough' }],
  labels: new Map(),
  diagnostics: [],
  sourceKind: 'raw-elf-capstone',
  architecture: 'x86-64',
  entryAddress: 0x406820,
  viewKind: 'function-cfg',
  functionAddress: 0x406820,
  functionName: '_start'
};

const summary = {
  rootAddress: 0x406820,
  functions: [
    { address: 0x406820, endAddress: 0x406900, size: 0xe0 },
    { address: 0x407000, endAddress: 0x407100, size: 0x100 }
  ],
  image: {
    segments: [
      { executable: true, virtualAddress: 0x406000, memorySize: 0x3000 },
      { executable: false, virtualAddress: 0x500000, memorySize: 0x1000 }
    ]
  }
} as BinaryAnalysisSummary;

const snapshot = {
  status: 'paused',
  lastInstruction: instruction(0x406828, 0x40682c),
  registers: { rip: 0x40682cn }
} as unknown as ExecutionSnapshot;

assertEqual(executionAddressFromSnapshot(snapshot), 0x406828, 'paused address');
assertEqual(graphNodeForAddress(graph, 0x40682a)?.id, 'bb-next', 'CFG block lookup');
assertEqual(findBinaryFunctionForAddress(summary, 0x406850), 0x406820, 'first function lookup');
assertEqual(findBinaryFunctionForAddress(summary, 0x407050), 0x407000, 'second function lookup');
assertEqual(imageContainsExecutableAddress(summary, 0x406828), true, 'main image executable address');
assertEqual(imageContainsExecutableAddress(summary, 0x500010), false, 'non-executable address');
assertEqual(executionAddressFromSnapshot({ ...snapshot, status: 'running' }), null, 'running snapshot must not follow');

console.log('execution follow smoke: PASS (paused PC -> disassembly address -> function -> CFG block)');
