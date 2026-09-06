import type { CapstoneHandle, CapstoneInstruction, CapstoneModule } from '../../src/features/capstone/types';
import type { LoadedImage } from '../../src/features/binary/model';
import type { ProjectFile } from '../../src/features/project/model';
import { X86ExecutionSession } from '../../src/features/execution/session';
import { DEFAULT_EXECUTION_POLICY } from '../../src/features/execution/model';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertOk(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`${label}: expected truthy value`);
}

const ENTRY = 0x400000;
const INSN_PTR = 0x1000;
const DETAIL_PTR = 0x2000;
const ARCH_PTR = DETAIL_PTR + 96;
const OPERAND_BASE = ARCH_PTR + 72;
const OPERAND_SIZE = 48;

interface FakeOperand {
  type: number;
  size: number;
  access: number;
  regId?: number;
  imm?: bigint;
}

interface FakeInstructionDescription {
  instruction: CapstoneInstruction;
  operands: FakeOperand[];
}

let current: FakeInstructionDescription | null = null;

const REG_EAX = 1;
const REG_EDI = 2;
const X86_OP_REG = 1;
const X86_OP_IMM = 2;
const X86_OP_FP = 3;
const X86_OP_MEM = 4;
const AC_READ = 1;
const AC_WRITE = 2;

function decode(bytes: Uint8Array, address: number): FakeInstructionDescription {
  if (bytes[0] === 0x31 && bytes[1] === 0xff) {
    return {
      instruction: { id: 1, address, size: 2, bytes: [0x31, 0xff], mnemonic: 'xor', op_str: 'edi, edi' },
      operands: [
        { type: X86_OP_REG, size: 4, access: AC_READ | AC_WRITE, regId: REG_EDI },
        { type: X86_OP_REG, size: 4, access: AC_READ, regId: REG_EDI }
      ]
    };
  }
  if (bytes[0] === 0xb8 && bytes[1] === 0x3c) {
    return {
      instruction: { id: 2, address, size: 5, bytes: [0xb8, 0x3c, 0, 0, 0], mnemonic: 'mov', op_str: 'eax, 0x3c' },
      operands: [
        { type: X86_OP_REG, size: 4, access: AC_WRITE, regId: REG_EAX },
        { type: X86_OP_IMM, size: 4, access: AC_READ, imm: 60n }
      ]
    };
  }
  if (bytes[0] === 0x0f && bytes[1] === 0x05) {
    return {
      instruction: { id: 3, address, size: 2, bytes: [0x0f, 0x05], mnemonic: 'syscall', op_str: '' },
      operands: []
    };
  }
  throw new Error(`Fake Capstone received unknown bytes at 0x${address.toString(16)}: ${[...bytes.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}`);
}

class FakeCapstoneHandle implements CapstoneHandle {
  option(): void {}
  disasm(): CapstoneInstruction[] { return []; }
  disasm_iter(buffer: number[] | Uint8Array, address: number, callback: (instruction: CapstoneInstruction, instructionPointer: number) => boolean | void): number {
    const bytes = buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer);
    current = decode(bytes, address);
    callback(current.instruction, INSN_PTR);
    return 1;
  }
  regs_access(): { regs_read: number[]; regs_write: number[] } {
    if (!current) return { regs_read: [], regs_write: [] };
    return {
      regs_read: current.operands.filter((operand) => operand.type === X86_OP_REG && (operand.access & AC_READ) !== 0).map((operand) => operand.regId ?? 0).filter(Boolean),
      regs_write: current.operands.filter((operand) => operand.type === X86_OP_REG && (operand.access & AC_WRITE) !== 0).map((operand) => operand.regId ?? 0).filter(Boolean)
    };
  }
  op_count(_instructionPointer: number, operandType: number): number {
    return current?.operands.filter((operand) => operand.type === operandType).length ?? 0;
  }
  insn_group(): boolean { return false; }
  reg_name(registerId: number): string { return registerId === REG_EAX ? 'eax' : registerId === REG_EDI ? 'edi' : ''; }
  insn_name(instructionId: number): string { return instructionId === 1 ? 'xor' : instructionId === 2 ? 'mov' : instructionId === 3 ? 'syscall' : ''; }
  close(): void {}
}

const fakeCapstone: CapstoneModule = {
  ARCH_X86: 3,
  MODE_64: 8,
  MODE_32: 4,
  OPT_DETAIL: 2,
  OPT_ON: 3,
  AC_READ,
  AC_WRITE,
  X86_OP_REG,
  X86_OP_IMM,
  X86_OP_FP,
  X86_OP_MEM,
  GRP_JUMP: 1,
  GRP_CALL: 2,
  GRP_RET: 3,
  GRP_BRANCH_RELATIVE: 4,
  getValue(pointer: number): number | bigint {
    if (!current) return 0;
    if (pointer === INSN_PTR + 236) return DETAIL_PTR;
    if (pointer === ARCH_PTR + 64) return current.operands.length;
    if (pointer >= OPERAND_BASE && pointer < OPERAND_BASE + current.operands.length * OPERAND_SIZE) {
      const relative = pointer - OPERAND_BASE;
      const operand = current.operands[Math.floor(relative / OPERAND_SIZE)];
      const field = relative % OPERAND_SIZE;
      if (field === 0) return operand.type;
      if (field === 8) return operand.type === X86_OP_REG ? operand.regId ?? 0 : operand.imm ?? 0n;
      if (field === 32) return operand.size;
      if (field === 33) return operand.access;
      return 0;
    }
    return 0;
  },
  version(): number { return (5 << 8) | 0; },
  Capstone: FakeCapstoneHandle
};

const programBytes = Uint8Array.from([
  0x31, 0xff,                   // xor edi, edi
  0xb8, 0x3c, 0x00, 0x00, 0x00, // mov eax, 60
  0x0f, 0x05                    // syscall -> exit(0)
]);

const file: ProjectFile = {
  id: 'execution-smoke',
  path: 'fixtures/execution-smoke',
  name: 'execution-smoke',
  kind: 'binary',
  language: 'binary',
  bytes: programBytes.buffer.slice(programBytes.byteOffset, programBytes.byteOffset + programBytes.byteLength),
  size: programBytes.byteLength,
  updatedAt: 1
};

const image: LoadedImage = {
  schema: 'asm-graph.loaded-image/v1',
  sourceFileId: file.id,
  sourcePath: file.path,
  architecture: 'x86-64',
  byteOrder: 'little',
  kind: 'executable',
  entry: ENTRY,
  buildId: null,
  soname: null,
  neededLibraries: [],
  interpreter: null,
  segments: [{
    index: 0,
    type: 1,
    flags: 5,
    offset: 0,
    virtualAddress: ENTRY,
    fileSize: programBytes.byteLength,
    memorySize: 0x1000,
    alignment: 0x1000,
    readable: true,
    writable: false,
    executable: true
  }],
  sections: [],
  symbols: [],
  relocations: [],
  functions: [],
  unwind: { available: false, cies: [], fdes: [], errors: [], cfiDiagnostics: [], cfiRowCount: 0 }
};

const session = new X86ExecutionSession(file, image, fakeCapstone, {
  ...DEFAULT_EXECUTION_POLICY,
  maxInstructions: 16,
  maxMappedBytes: 4 * 1024 * 1024,
  stackBytes: 64 * 1024
});

try {
  const prepared = session.snapshot();
  assertEqual(prepared.status, 'ready', 'prepared status');
  assertEqual(prepared.registers?.rip, BigInt(ENTRY), 'prepared RIP');

  const first = session.step();
  assertEqual(first.status, 'paused', 'first step status');
  assertEqual(first.instructionCount, 1, 'first step instruction count');
  assertEqual(first.lastInstruction?.mnemonic, 'xor', 'first mnemonic');
  assertEqual(first.lastInstruction?.address, ENTRY, 'first address');
  assertEqual(first.registers?.rip, BigInt(ENTRY + 2), 'RIP after xor');
  assertEqual(first.registers?.rdi, 0n, 'RDI after xor');

  const second = session.step();
  assertEqual(second.status, 'paused', 'second step status');
  assertEqual(second.instructionCount, 2, 'second instruction count');
  assertEqual(second.lastInstruction?.mnemonic, 'mov', 'second mnemonic');
  assertEqual(second.registers?.rax, 60n, 'RAX after mov');
  assertEqual(second.registers?.rip, BigInt(ENTRY + 7), 'RIP after mov');

  const exited = session.step();
  assertEqual(exited.status, 'exited', 'exit status');
  assertEqual(exited.instructionCount, 3, 'exit instruction count');
  assertEqual(exited.lastInstruction?.mnemonic, 'syscall', 'exit mnemonic');
  assertEqual(exited.exitCode, 0, 'exit code');
  assertEqual(exited.trapReason, null, 'trap reason');
  assertOk(exited.events.some((event) => event.kind === 'exit' && event.code === 0), 'exit event');

  console.log('bounded execution smoke: PASS (xor -> mov eax,60 -> syscall exit(0))');
} finally {
  session.dispose();
}
