import type { CapstoneHandle, CapstoneInstruction, CapstoneModule } from '../../src/features/capstone/types';
import { runAsmHeadless, runElfHeadless } from '../../src/features/execution/headless/runner';
import { makeMinimalStaticElf } from './headless-fixtures';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertOk(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`${label}: expected truthy value`);
}

const X86_OP_REG = 1;
const X86_OP_IMM = 2;
const X86_OP_FP = 3;
const X86_OP_MEM = 4;
const AC_READ = 1;
const AC_WRITE = 2;
const REG_EAX = 1;
const REG_EDI = 2;
const INSN_PTR = 0x1000;
const DETAIL_PTR = 0x2000;
const ARCH_PTR = DETAIL_PTR + 96;
const OPERAND_BASE = ARCH_PTR + 72;
const OPERAND_SIZE = 48;

type FakeOperand = { type: number; size: number; access: number; regId?: number; imm?: bigint };
type FakeDecoded = { instruction: CapstoneInstruction; operands: FakeOperand[] };
let current: FakeDecoded | null = null;

function fakeDecode(bytes: Uint8Array, address: number): FakeDecoded {
  if (bytes[0] === 0x31 && bytes[1] === 0xff) return {
    instruction: { id: 1, address, size: 2, bytes: [0x31, 0xff], mnemonic: 'xor', op_str: 'edi, edi' },
    operands: [
      { type: X86_OP_REG, size: 4, access: AC_READ | AC_WRITE, regId: REG_EDI },
      { type: X86_OP_REG, size: 4, access: AC_READ, regId: REG_EDI }
    ]
  };
  if (bytes[0] === 0xb8 && bytes[1] === 0x3c) return {
    instruction: { id: 2, address, size: 5, bytes: [0xb8, 0x3c, 0, 0, 0], mnemonic: 'mov', op_str: 'eax, 0x3c' },
    operands: [
      { type: X86_OP_REG, size: 4, access: AC_WRITE, regId: REG_EAX },
      { type: X86_OP_IMM, size: 4, access: AC_READ, imm: 60n }
    ]
  };
  if (bytes[0] === 0x0f && bytes[1] === 0x05) return {
    instruction: { id: 3, address, size: 2, bytes: [0x0f, 0x05], mnemonic: 'syscall', op_str: '' },
    operands: []
  };
  throw new Error(`Unknown fixture opcode 0x${bytes[0]?.toString(16) ?? '??'} at 0x${address.toString(16)}.`);
}

class FakeHandle implements CapstoneHandle {
  option(): void {}
  disasm(): CapstoneInstruction[] { return []; }
  disasm_iter(buffer: number[] | Uint8Array, address: number, callback: (instruction: CapstoneInstruction, instructionPointer: number) => boolean | void): number {
    current = fakeDecode(buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer), address);
    callback(current.instruction, INSN_PTR);
    return 1;
  }
  regs_access(): { regs_read: number[]; regs_write: number[] } {
    if (!current) return { regs_read: [], regs_write: [] };
    return {
      regs_read: current.operands.filter((op) => op.type === X86_OP_REG && (op.access & AC_READ)).map((op) => op.regId ?? 0).filter(Boolean),
      regs_write: current.operands.filter((op) => op.type === X86_OP_REG && (op.access & AC_WRITE)).map((op) => op.regId ?? 0).filter(Boolean)
    };
  }
  op_count(_instructionPointer: number, operandType: number): number { return current?.operands.filter((op) => op.type === operandType).length ?? 0; }
  insn_group(): boolean { return false; }
  reg_name(registerId: number): string { return registerId === REG_EAX ? 'eax' : registerId === REG_EDI ? 'edi' : ''; }
  insn_name(instructionId: number): string { return instructionId === 1 ? 'xor' : instructionId === 2 ? 'mov' : instructionId === 3 ? 'syscall' : ''; }
  close(): void {}
}

const fakeCapstone: CapstoneModule = {
  ARCH_X86: 3, MODE_64: 8, MODE_32: 4, OPT_DETAIL: 2, OPT_ON: 3,
  AC_READ, AC_WRITE, X86_OP_REG, X86_OP_IMM, X86_OP_FP, X86_OP_MEM,
  GRP_JUMP: 1, GRP_CALL: 2, GRP_RET: 3, GRP_BRANCH_RELATIVE: 4,
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
    }
    return 0;
  },
  version(): number { return (5 << 8); },
  Capstone: FakeHandle
};

const asm = `bits 64
section .data
msg: db "hello headless!\\n"
section .text
global _start
_start:
  mov eax, 1
  mov edi, 1
  mov rsi, msg
  mov edx, 16
  syscall
  mov eax, 60
  xor edi, edi
  syscall
`;

const asmResult = runAsmHeadless('fixtures/hello.asm', asm, { maxInstructions: 64 });
assertEqual(asmResult.snapshot.status, 'exited', 'ASM status');
assertEqual(asmResult.snapshot.exitCode, 0, 'ASM exit code');
assertEqual(asmResult.snapshot.stdout, 'hello headless!\n', 'ASM stdout');
assertEqual(asmResult.snapshot.provider, 'asm-source-x86-64', 'ASM provider');

const elfResult = runElfHeadless('fixtures/minimal-static-elf', makeMinimalStaticElf(), { capstone: fakeCapstone, maxInstructions: 16 });
assertEqual(elfResult.snapshot.status, 'exited', 'ELF status');
assertEqual(elfResult.snapshot.exitCode, 0, 'ELF exit code');
assertEqual(elfResult.snapshot.provider, 'bounded-x86-64', 'ELF provider');
assertEqual(elfResult.snapshot.instructionCount, 3, 'ELF instruction count');
assertOk(elfResult.snapshot.events.some((event) => event.kind === 'exit' && event.code === 0), 'ELF exit event');

console.log('headless runner smoke: PASS (ASM source + static ELF, zero UI)');
