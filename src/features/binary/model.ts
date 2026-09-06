export type ElfKind = 'executable' | 'pie-executable' | 'shared-library' | 'relocatable' | 'core' | 'unknown';

export interface ElfHeaderSummary {
  valid: boolean;
  reason?: string;
  elfClass?: 32 | 64;
  littleEndian?: boolean;
  machine?: number;
  architecture?: string;
  type?: number;
  kind?: ElfKind;
  entry?: number;
}

export interface ElfSegment {
  index: number;
  type: number;
  flags: number;
  offset: number;
  virtualAddress: number;
  fileSize: number;
  memorySize: number;
  alignment: number;
  readable: boolean;
  writable: boolean;
  executable: boolean;
}

export interface ElfSection {
  index: number;
  name: string;
  type: number;
  flags: number;
  address: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  alignment: number;
  entrySize: number;
  executable: boolean;
  writable: boolean;
  allocated: boolean;
}

export interface ElfSymbol {
  index: number;
  tableSectionIndex: number;
  name: string;
  value: number;
  size: number;
  binding: number;
  type: number;
  visibility: number;
  sectionIndex: number;
  defined: boolean;
  functionLike: boolean;
}

export interface ElfRelocation {
  sectionIndex: number;
  sectionName: string;
  offset: number;
  type: number;
  symbolIndex: number;
  symbolName: string;
  addend: number | null;
}

export type ElfUnwindSource = 'eh_frame' | 'debug_frame';

export interface ElfUnwindFde {
  id: string;
  source: ElfUnwindSource;
  entryAddress: number;
  cieAddress: number;
  startAddress: number;
  endAddress: number;
  addressRange: number;
  sectionIndex: number;
  sectionName: string;
  parseComplete: boolean;
}

export interface ElfUnwindModel {
  available: boolean;
  fdes: ElfUnwindFde[];
  errors: string[];
}

export interface LoadedImage {
  schema: 'asm-graph.loaded-image/v1';
  sourceFileId: string;
  sourcePath: string;
  architecture: 'x86-64';
  byteOrder: 'little';
  kind: ElfKind;
  entry: number;
  buildId: string | null;
  soname: string | null;
  neededLibraries: string[];
  interpreter: string | null;
  segments: ElfSegment[];
  sections: ElfSection[];
  symbols: ElfSymbol[];
  relocations: ElfRelocation[];
  functions: ElfSymbol[];
  unwind: ElfUnwindModel;
}

export interface CanonicalOperandAccess {
  read: boolean;
  write: boolean;
}

export interface CanonicalMemoryOperand {
  segment: string | null;
  base: string | null;
  index: string | null;
  scale: number;
  displacement: number | string;
  width: number;
  access: CanonicalOperandAccess;
  evidence: 'capstone-x86-detail';
}

export type CanonicalOperand =
  | { index: number; kind: 'register'; size: number; access: CanonicalOperandAccess; register: string | null }
  | { index: number; kind: 'immediate'; size: number; access: CanonicalOperandAccess; value: number | string }
  | { index: number; kind: 'floating'; size: number; access: CanonicalOperandAccess; value: number }
  | { index: number; kind: 'memory'; size: number; access: CanonicalOperandAccess; memory: CanonicalMemoryOperand }
  | { index: number; kind: 'other'; size: number; access: CanonicalOperandAccess };

export interface CanonicalInstruction {
  schema: 'asm-graph.decoded-instruction/v1';
  address: number;
  endAddress: number;
  size: number;
  bytes: number[];
  id: number;
  mnemonic: string;
  operands: string;
  operandDetails: CanonicalOperand[];
  memoryOperands: CanonicalMemoryOperand[];
  explicitRegisterReads: string[];
  explicitRegisterWrites: string[];
  registerReads: string[];
  registerWrites: string[];
  groups: number[];
  controlFlow: 'none' | 'jump' | 'call' | 'return' | 'syscall';
  directTarget: number | null;
  decoderDetail: {
    prefix: number[];
    opcode: number[];
    rex: number;
    addressSize: number;
    modrm: number;
    sib: number;
    displacement: number | string;
    eflags: number | string;
    evidence: 'pinned-capstone-5.0.9-wasm32-layout';
  };
  evidence: 'capstone-x86-5.0.9';
}

export type BinaryFunctionEvidenceKind =
  | 'symbol'
  | 'unwind-fde'
  | 'entrypoint'
  | 'section-entry'
  | 'direct-call'
  | 'tail-call'
  | 'cet-landing-pad'
  | 'prologue'
  | 'aligned-after-return';

export interface BinaryFunctionCandidate {
  address: number;
  endAddress: number | null;
  size: number | null;
  name: string;
  sectionIndex: number;
  sectionName: string;
  kind: BinaryFunctionEvidenceKind;
  confidence: 'exact' | 'inferred' | 'heuristic';
  evidence: string;
  symbol: ElfSymbol | null;
  unwindFde: ElfUnwindFde | null;
  leadingPaddingBytes: number;
}

export interface ElfPltStub {
  address: number;
  endAddress: number;
  size: number;
  name: string;
  symbolName: string | null;
  sectionName: string;
  gotAddress: number;
  relocation: ElfRelocation;
  ifunc: boolean;
  resolverAddress: number | null;
  evidence: 'capstone-rip-memory+raw-elf-relocation';
}

export interface BinaryAnalysisSummary {
  image: LoadedImage;
  rootName: string;
  rootAddress: number;
  rootSize: number | null;
  instructions: CanonicalInstruction[];
  functions: BinaryFunctionCandidate[];
  pltStubs: ElfPltStub[];
}
