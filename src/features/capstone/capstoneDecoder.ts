import type {
  CanonicalInstruction,
  CanonicalMemoryOperand,
  CanonicalOperand,
  CanonicalOperandAccess
} from '../binary/model';
import type { CapstoneHandle, CapstoneInstruction, CapstoneModule } from './types';

const PINNED_WASM32_LAYOUT = Object.freeze({
  csInsnDetailPointerOffset: 236,
  csDetailArchUnionOffset: 96,
  x86OperandCountOffset: 64,
  x86OperandsOffset: 72,
  x86OperandSize: 48
});

interface LiveOperand {
  index: number;
  type: number;
  size: number;
  access: number;
  regId?: number;
  reg?: string | null;
  imm?: number | bigint;
  fp?: number;
  mem?: {
    segmentId: number;
    segment: string | null;
    baseId: number;
    base: string | null;
    indexId: number;
    index: string | null;
    scale: number;
    disp: number | bigint;
  };
}

interface LiveDetail {
  operands: LiveOperand[];
  prefix: number[];
  opcode: number[];
  rex: number;
  addressSize: number;
  modrm: number;
  sib: number;
  displacement: number | bigint;
  eflags: number | bigint;
}

function addressNumber(address: number | bigint): number {
  const value = typeof address === 'bigint' ? Number(address) : address;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Capstone returned an address outside the browser-safe integer range.');
  return value;
}

function safeScalar(value: number | bigint): number | string {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value);
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}

function safeAddress(value: number | bigint | undefined): number | null {
  if (value === undefined) return null;
  const number = typeof value === 'bigint' ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueRegisterNames(handle: CapstoneHandle, ids: number[]): string[] {
  return unique(ids.map((id) => handle.reg_name(id)));
}

function liveX86Detail(module: CapstoneModule, handle: CapstoneHandle, instructionPointer: number): LiveDetail {
  const layout = PINNED_WASM32_LAYOUT;
  const detailPointer = Number(module.getValue(instructionPointer + layout.csInsnDetailPointerOffset, '*'));
  if (!detailPointer) {
    return { operands: [], prefix: [], opcode: [], rex: 0, addressSize: 0, modrm: 0, sib: 0, displacement: 0, eflags: 0 };
  }

  const arch = detailPointer + layout.csDetailArchUnionOffset;
  const operandCount = Number(module.getValue(arch + layout.x86OperandCountOffset, 'i8')) & 0xff;
  const operands: LiveOperand[] = [];

  for (let index = 0; index < Math.min(operandCount, 8); index += 1) {
    const pointer = arch + layout.x86OperandsOffset + index * layout.x86OperandSize;
    const type = Number(module.getValue(pointer, 'i32'));
    const size = Number(module.getValue(pointer + 32, 'i8')) & 0xff;
    const access = Number(module.getValue(pointer + 33, 'i8')) & 0xff;
    const operand: LiveOperand = { index, type, size, access };

    if (type === module.X86_OP_REG) {
      operand.regId = Number(module.getValue(pointer + 8, 'i32'));
      operand.reg = operand.regId ? handle.reg_name(operand.regId) : null;
    } else if (type === module.X86_OP_IMM) {
      operand.imm = module.getValue(pointer + 8, 'i64');
    } else if (type === module.X86_OP_FP) {
      operand.fp = Number(module.getValue(pointer + 8, 'double'));
    } else if (type === module.X86_OP_MEM) {
      const segmentId = Number(module.getValue(pointer + 8, 'i32'));
      const baseId = Number(module.getValue(pointer + 12, 'i32'));
      const indexId = Number(module.getValue(pointer + 16, 'i32'));
      operand.mem = {
        segmentId,
        segment: segmentId ? handle.reg_name(segmentId) : null,
        baseId,
        base: baseId ? handle.reg_name(baseId) : null,
        indexId,
        index: indexId ? handle.reg_name(indexId) : null,
        scale: Number(module.getValue(pointer + 20, 'i32')),
        disp: module.getValue(pointer + 24, 'i64')
      };
    }
    operands.push(operand);
  }

  return {
    operands,
    prefix: [0, 1, 2, 3].map((index) => Number(module.getValue(arch + index, 'i8')) & 0xff),
    opcode: [0, 1, 2, 3].map((index) => Number(module.getValue(arch + 4 + index, 'i8')) & 0xff),
    rex: Number(module.getValue(arch + 8, 'i8')) & 0xff,
    addressSize: Number(module.getValue(arch + 9, 'i8')) & 0xff,
    modrm: Number(module.getValue(arch + 10, 'i8')) & 0xff,
    sib: Number(module.getValue(arch + 11, 'i8')) & 0xff,
    displacement: module.getValue(arch + 16, 'i64'),
    eflags: module.getValue(arch + 56, 'i64')
  };
}

function operandAccess(module: CapstoneModule, rawAccess: number): CanonicalOperandAccess {
  return {
    read: (rawAccess & module.AC_READ) !== 0,
    write: (rawAccess & module.AC_WRITE) !== 0
  };
}

function canonicalOperands(module: CapstoneModule, detail: LiveDetail): {
  operands: CanonicalOperand[];
  memoryOperands: CanonicalMemoryOperand[];
  explicitReads: string[];
  explicitWrites: string[];
} {
  const operands: CanonicalOperand[] = [];
  const memoryOperands: CanonicalMemoryOperand[] = [];
  const explicitReads: string[] = [];
  const explicitWrites: string[] = [];

  for (const raw of detail.operands) {
    const access = operandAccess(module, raw.access);
    if (raw.type === module.X86_OP_REG) {
      const register = raw.reg ?? null;
      if (register && access.read) explicitReads.push(register);
      if (register && access.write) explicitWrites.push(register);
      operands.push({ index: raw.index, kind: 'register', size: raw.size, access, register });
      continue;
    }
    if (raw.type === module.X86_OP_IMM) {
      operands.push({ index: raw.index, kind: 'immediate', size: raw.size, access, value: safeScalar(raw.imm ?? 0) });
      continue;
    }
    if (raw.type === module.X86_OP_FP) {
      operands.push({ index: raw.index, kind: 'floating', size: raw.size, access, value: raw.fp ?? 0 });
      continue;
    }
    if (raw.type === module.X86_OP_MEM) {
      const memory: CanonicalMemoryOperand = {
        segment: raw.mem?.segment ?? null,
        base: raw.mem?.base ?? null,
        index: raw.mem?.index ?? null,
        scale: raw.mem?.scale ?? 1,
        displacement: safeScalar(raw.mem?.disp ?? 0),
        width: raw.size,
        access,
        evidence: 'capstone-x86-detail'
      };
      for (const register of [memory.segment, memory.base, memory.index]) {
        if (register) explicitReads.push(register);
      }
      memoryOperands.push(memory);
      operands.push({ index: raw.index, kind: 'memory', size: raw.size, access, memory });
      continue;
    }
    operands.push({ index: raw.index, kind: 'other', size: raw.size, access });
  }

  return {
    operands,
    memoryOperands,
    explicitReads: unique(explicitReads),
    explicitWrites: unique(explicitWrites)
  };
}

function canonicalize(module: CapstoneModule, handle: CapstoneHandle, instruction: CapstoneInstruction, pointer: number): CanonicalInstruction {
  const detail = liveX86Detail(module, handle, pointer);
  const nativeOperandCount =
    handle.op_count(pointer, module.X86_OP_REG) +
    handle.op_count(pointer, module.X86_OP_IMM) +
    handle.op_count(pointer, module.X86_OP_MEM) +
    handle.op_count(pointer, module.X86_OP_FP);
  if (nativeOperandCount !== detail.operands.length) {
    throw new Error(`Pinned Capstone x86 detail-layout mismatch at 0x${addressNumber(instruction.address).toString(16)}: native=${nativeOperandCount}, detail=${detail.operands.length}.`);
  }

  const access = handle.regs_access(pointer);
  const isCall = handle.insn_group(pointer, module.GRP_CALL);
  const isJump = handle.insn_group(pointer, module.GRP_JUMP);
  const isReturn = handle.insn_group(pointer, module.GRP_RET);
  const mnemonic = instruction.mnemonic.toLowerCase();
  const isSyscall = mnemonic === 'syscall' || mnemonic === 'sysenter' || mnemonic === 'int';
  const controlFlow = isSyscall ? 'syscall' : isCall ? 'call' : isReturn ? 'return' : isJump ? 'jump' : 'none';
  const canonical = canonicalOperands(module, detail);
  const immediate = detail.operands.find((operand) => operand.type === module.X86_OP_IMM)?.imm;
  const groups = [
    isJump ? module.GRP_JUMP : null,
    isCall ? module.GRP_CALL : null,
    isReturn ? module.GRP_RET : null,
    module.GRP_BRANCH_RELATIVE && handle.insn_group(pointer, module.GRP_BRANCH_RELATIVE) ? module.GRP_BRANCH_RELATIVE : null
  ].filter((value): value is number => typeof value === 'number');
  const address = addressNumber(instruction.address);

  return {
    schema: 'asm-graph.decoded-instruction/v1',
    address,
    endAddress: address + instruction.size,
    size: instruction.size,
    bytes: [...instruction.bytes],
    id: instruction.id,
    mnemonic: instruction.mnemonic,
    operands: instruction.op_str,
    operandDetails: canonical.operands,
    memoryOperands: canonical.memoryOperands,
    explicitRegisterReads: canonical.explicitReads,
    explicitRegisterWrites: canonical.explicitWrites,
    registerReads: uniqueRegisterNames(handle, access.regs_read),
    registerWrites: uniqueRegisterNames(handle, access.regs_write),
    groups,
    controlFlow,
    directTarget: controlFlow === 'call' || controlFlow === 'jump' ? safeAddress(immediate) : null,
    decoderDetail: {
      prefix: detail.prefix,
      opcode: detail.opcode,
      rex: detail.rex,
      addressSize: detail.addressSize,
      modrm: detail.modrm,
      sib: detail.sib,
      displacement: safeScalar(detail.displacement),
      eflags: safeScalar(detail.eflags),
      evidence: 'pinned-capstone-5.0.9-wasm32-layout'
    },
    evidence: 'capstone-x86-5.0.9'
  };
}

export interface X86_64InstructionDecoder {
  decodeOne(bytes: Uint8Array, address: number): CanonicalInstruction | null;
  close(): void;
}

export function createX86_64InstructionDecoder(module: CapstoneModule): X86_64InstructionDecoder {
  const handle = new module.Capstone(module.ARCH_X86, module.MODE_64);
  let closed = false;
  handle.option(module.OPT_DETAIL, module.OPT_ON);
  return {
    decodeOne(bytes, address) {
      if (closed) throw new Error('Capstone execution decoder is closed.');
      let result: CanonicalInstruction | null = null;
      handle.disasm_iter(bytes, address, (instruction, pointer) => {
        result = canonicalize(module, handle, instruction, pointer);
        return false;
      });
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      handle.close();
    }
  };
}

export function decodeX86_64(
  module: CapstoneModule,
  bytes: Uint8Array,
  address: number,
  options: { maxInstructions?: number; stopAtReturn?: boolean } = {}
): CanonicalInstruction[] {
  const handle = new module.Capstone(module.ARCH_X86, module.MODE_64);
  const instructions: CanonicalInstruction[] = [];
  const maxInstructions = options.maxInstructions ?? 2048;
  handle.option(module.OPT_DETAIL, module.OPT_ON);
  try {
    handle.disasm_iter(bytes, address, (instruction, pointer) => {
      const canonical = canonicalize(module, handle, instruction, pointer);
      instructions.push(canonical);
      if (instructions.length >= maxInstructions) return false;
      if (options.stopAtReturn && canonical.controlFlow === 'return') return false;
      return true;
    });
  } finally {
    handle.close();
  }
  return instructions;
}
