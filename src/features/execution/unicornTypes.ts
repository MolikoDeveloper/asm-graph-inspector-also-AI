export type UnicornAddress = number | bigint;

export interface UnicornHook {
  readonly __unicornHook?: never;
}

export interface UnicornEngine {
  reg_write_i64(regid: number, value: bigint): void;
  reg_read_i64(regid: number): bigint;
  mem_map(address: UnicornAddress, size: UnicornAddress, perms: number): void;
  mem_protect(address: UnicornAddress, size: UnicornAddress, perms: number): void;
  mem_unmap(address: UnicornAddress, size: UnicornAddress): void;
  mem_write(address: UnicornAddress, bytes: ArrayLike<number>): void;
  mem_read(address: UnicornAddress, size: UnicornAddress): Uint8Array;
  hook_add(
    type: number,
    callback: (...args: unknown[]) => unknown,
    userData?: unknown,
    begin?: UnicornAddress,
    end?: UnicornAddress,
    extra?: number
  ): UnicornHook;
  hook_del(hook: UnicornHook): void;
  emu_start(begin: UnicornAddress, until: UnicornAddress, timeout?: number, count?: number): void;
  emu_stop(): void;
  errno(): number;
  close(): void;
}

export interface UnicornModule {
  Unicorn: new (arch: number, mode: number) => UnicornEngine;
  ARCH_X86: number;
  MODE_64: number;
  PROT_NONE: number;
  PROT_READ: number;
  PROT_WRITE: number;
  PROT_EXEC: number;
  PROT_ALL: number;
  HOOK_CODE: number;
  HOOK_INSN: number;
  X86_INS_SYSCALL: number;
  X86_REG_RAX: number;
  X86_REG_RBX: number;
  X86_REG_RCX: number;
  X86_REG_RDX: number;
  X86_REG_RSI: number;
  X86_REG_RDI: number;
  X86_REG_RBP: number;
  X86_REG_RSP: number;
  X86_REG_RIP: number;
  X86_REG_R8: number;
  X86_REG_R9: number;
  X86_REG_R10: number;
  X86_REG_R11: number;
  X86_REG_R12: number;
  X86_REG_R13: number;
  X86_REG_R14: number;
  X86_REG_R15: number;
  X86_REG_FS_BASE: number;
  X86_REG_GS_BASE: number;
  X86_REG_RFLAGS: number;
  arch_supported(arch: number): boolean | number;
  version(): number;
  strerror(code: number): string;
}

export type UnicornFactory = (options?: Record<string, unknown>) => Promise<UnicornModule>;
