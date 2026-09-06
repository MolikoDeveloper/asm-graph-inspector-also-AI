export type DataflowProjection = 'flow' | 'registers' | 'memory' | 'calls' | 'raw';
export type DataflowValueKind =
  | 'entry'
  | 'constant'
  | 'copy'
  | 'expression'
  | 'address'
  | 'memory-entry'
  | 'memory-store'
  | 'memory-load'
  | 'call-result'
  | 'clobber'
  | 'phi'
  | 'unknown';

export interface DataflowUse {
  instructionId: string;
  role: string;
}

export interface DataflowValue {
  id: string;
  kind: DataflowValueKind;
  label: string;
  register: string | null;
  memoryKey: string | null;
  constant: string | null;
  definitionInstructionId: string | null;
  inputs: string[];
  uses: DataflowUse[];
  confidence: 'exact' | 'conservative';
  evidence: string;
}

export interface DataflowInstruction {
  id: string;
  line: number;
  address: number | null;
  mnemonic: string;
  operands: string;
  kind: 'instruction' | 'branch' | 'call' | 'syscall';
  registerReads: string[];
  registerWrites: string[];
  memoryReads: string[];
  memoryWrites: string[];
  controlFlow: 'none' | 'jump' | 'call' | 'return' | 'syscall';
}

export interface DataflowInstructionInfo {
  instruction: DataflowInstruction;
  uses: Array<{ valueId: string; role: string }>;
  defs: Array<{ valueId: string; role: string }>;
  callArguments: Array<{ register: string; valueId: string }>;
  returnValueId: string | null;
  syscallNumber: number | null;
  syscallName: string | null;
  notes: string[];
}

export interface DataflowResult {
  sourceKind: 'asm-source' | 'raw-elf-capstone';
  fileId: string;
  functionName: string | null;
  functionAddress: number | null;
  instructions: DataflowInstruction[];
  values: DataflowValue[];
  instructionInfo: Map<string, DataflowInstructionInfo>;
  phiValues: DataflowValue[];
  fixedPointConverged: boolean;
  fixedPointIterations: number;
  diagnostics: string[];
}
