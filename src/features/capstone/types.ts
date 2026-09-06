export interface CapstoneInstruction {
  id: number;
  address: number | bigint;
  size: number;
  bytes: number[];
  mnemonic: string;
  op_str: string;
  detail?: unknown;
}

export interface CapstoneRegisterAccess {
  regs_read: number[];
  regs_write: number[];
}

export interface CapstoneHandle {
  option(option: number, value: number): void;
  disasm(buffer: number[] | Uint8Array, address?: number, max?: number): CapstoneInstruction[];
  disasm_iter(buffer: number[] | Uint8Array, address: number, callback: (instruction: CapstoneInstruction, instructionPointer: number) => boolean | void): number;
  regs_access(instructionPointer: number): CapstoneRegisterAccess;
  op_count(instructionPointer: number, operandType: number): number;
  insn_group(instructionPointer: number, groupId: number): boolean;
  reg_name(registerId: number): string;
  insn_name(instructionId: number): string;
  close(): void;
}

export type CapstoneValueType = 'i8' | 'i16' | 'i32' | 'i64' | 'float' | 'double' | '*' | `${string}*`;

export interface CapstoneModule {
  ARCH_X86: number;
  MODE_64: number;
  MODE_32: number;
  OPT_DETAIL: number;
  OPT_ON: number;
  AC_READ: number;
  AC_WRITE: number;
  X86_OP_REG: number;
  X86_OP_IMM: number;
  X86_OP_FP: number;
  X86_OP_MEM: number;
  GRP_JUMP: number;
  GRP_CALL: number;
  GRP_RET: number;
  GRP_BRANCH_RELATIVE?: number;
  getValue(pointer: number, type?: CapstoneValueType): number | bigint;
  version(): number;
  Capstone: new (arch: number, mode: number) => CapstoneHandle;
}

declare global {
  interface Window {
    MCapstone?: (options?: { locateFile?: (path: string) => string }) => Promise<CapstoneModule>;
  }
}
