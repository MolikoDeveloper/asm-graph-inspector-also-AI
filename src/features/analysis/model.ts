import type { CanonicalMemoryOperand, CanonicalOperand } from '../binary/model';

export type GraphNodeKind = 'label' | 'instruction' | 'branch' | 'call' | 'syscall' | 'data';

export interface GraphNodeProperty {
  label: string;
  value: string;
}

export interface GraphNode {
  id: string;
  line: number;
  address?: number;
  title: string;
  detail: string;
  kind: GraphNodeKind;
  x?: number;
  y?: number;
  evidence?: string;
  category?: string;
  properties?: GraphNodeProperty[];
  registerReads?: string[];
  registerWrites?: string[];
  bytes?: number[];
  operandDetails?: CanonicalOperand[];
  memoryOperands?: CanonicalMemoryOperand[];
  blockInstructions?: import('../binary/model').CanonicalInstruction[];
  cfiSummary?: string;
  reachable?: boolean;
  mnemonic?: string;
  operands?: string;
  dataflowUses?: string[];
  dataflowDefs?: string[];
  dataflowValueKind?: string;
  dataflowValueCount?: number;
  dataflowLane?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'control' | 'branch' | 'call' | 'data';
  label?: string;
  /** CFG evidence that the edge returns to an earlier block in the function. */
  loopBack?: boolean;
}

export interface AnalysisGraph {
  fileId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  labels: Map<string, string>;
  diagnostics: string[];
  sourceKind?: 'asm-source' | 'disassembly-dump' | 'raw-elf-capstone';
  architecture?: string;
  entryAddress?: number;
  viewKind?: 'source-flow' | 'function-cfg' | 'program-flow' | 'dataflow' | 'binary-structure';
  functionAddress?: number;
  functionName?: string;
  dataflowProjection?: 'flow' | 'registers' | 'memory' | 'calls' | 'raw';
}
