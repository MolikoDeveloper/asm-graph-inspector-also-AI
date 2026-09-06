import type { ExecutionRegisterSnapshot } from './model';

const MASK64 = (1n << 64n) - 1n;

type BaseRegister = keyof ExecutionRegisterSnapshot;

interface RegisterAlias {
  base: BaseRegister;
  bits: number;
  shift: number;
  zeroExtend32?: boolean;
}

const BASES: BaseRegister[] = [
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'rip',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rflags'
];

const aliases = new Map<string, RegisterAlias>();

function addFamily(base: BaseRegister, names: [string, string, string, string?]) {
  aliases.set(base, { base, bits: 64, shift: 0 });
  aliases.set(names[0], { base, bits: 32, shift: 0, zeroExtend32: true });
  aliases.set(names[1], { base, bits: 16, shift: 0 });
  aliases.set(names[2], { base, bits: 8, shift: 0 });
  if (names[3]) aliases.set(names[3], { base, bits: 8, shift: 8 });
}

addFamily('rax', ['eax', 'ax', 'al', 'ah']);
addFamily('rbx', ['ebx', 'bx', 'bl', 'bh']);
addFamily('rcx', ['ecx', 'cx', 'cl', 'ch']);
addFamily('rdx', ['edx', 'dx', 'dl', 'dh']);
addFamily('rsi', ['esi', 'si', 'sil']);
addFamily('rdi', ['edi', 'di', 'dil']);
addFamily('rbp', ['ebp', 'bp', 'bpl']);
addFamily('rsp', ['esp', 'sp', 'spl']);
aliases.set('rip', { base: 'rip', bits: 64, shift: 0 });
aliases.set('eip', { base: 'rip', bits: 32, shift: 0, zeroExtend32: true });
aliases.set('ip', { base: 'rip', bits: 16, shift: 0 });

for (let index = 8; index <= 15; index += 1) {
  const base = `r${index}` as BaseRegister;
  aliases.set(base, { base, bits: 64, shift: 0 });
  aliases.set(`r${index}d`, { base, bits: 32, shift: 0, zeroExtend32: true });
  aliases.set(`r${index}w`, { base, bits: 16, shift: 0 });
  aliases.set(`r${index}b`, { base, bits: 8, shift: 0 });
}

aliases.set('eflags', { base: 'rflags', bits: 32, shift: 0, zeroExtend32: true });
aliases.set('flags', { base: 'rflags', bits: 16, shift: 0 });
aliases.set('rflags', { base: 'rflags', bits: 64, shift: 0 });

function mask(bits: number): bigint {
  return bits >= 64 ? MASK64 : (1n << BigInt(bits)) - 1n;
}

export class X86RegisterFile {
  private values = new Map<BaseRegister, bigint>();

  constructor() {
    for (const base of BASES) this.values.set(base, 0n);
    this.values.set('rflags', 0x2n);
  }

  read(name: string): bigint {
    const alias = aliases.get(name.toLowerCase());
    if (!alias) throw new Error(`Unsupported x86-64 register ${name}.`);
    const value = this.values.get(alias.base) ?? 0n;
    return (value >> BigInt(alias.shift)) & mask(alias.bits);
  }

  write(name: string, value: bigint): void {
    const alias = aliases.get(name.toLowerCase());
    if (!alias) throw new Error(`Unsupported x86-64 register ${name}.`);
    const clipped = value & mask(alias.bits);
    if (alias.zeroExtend32) {
      this.values.set(alias.base, clipped);
      return;
    }
    if (alias.bits === 64 && alias.shift === 0) {
      this.values.set(alias.base, clipped & MASK64);
      return;
    }
    const old = this.values.get(alias.base) ?? 0n;
    const shiftedMask = mask(alias.bits) << BigInt(alias.shift);
    const next = (old & ~shiftedMask) | ((clipped << BigInt(alias.shift)) & shiftedMask);
    this.values.set(alias.base, next & MASK64);
  }

  setFlag(bit: number, enabled: boolean): void {
    const bitMask = 1n << BigInt(bit);
    const value = this.values.get('rflags') ?? 0x2n;
    this.values.set('rflags', enabled ? value | bitMask : value & ~bitMask);
  }

  getFlag(bit: number): boolean {
    return ((this.values.get('rflags') ?? 0n) & (1n << BigInt(bit))) !== 0n;
  }

  snapshot(): ExecutionRegisterSnapshot {
    return {
      rax: this.read('rax'), rbx: this.read('rbx'), rcx: this.read('rcx'), rdx: this.read('rdx'),
      rsi: this.read('rsi'), rdi: this.read('rdi'), rbp: this.read('rbp'), rsp: this.read('rsp'),
      rip: this.read('rip'), r8: this.read('r8'), r9: this.read('r9'), r10: this.read('r10'),
      r11: this.read('r11'), r12: this.read('r12'), r13: this.read('r13'), r14: this.read('r14'),
      r15: this.read('r15'), rflags: this.read('rflags')
    };
  }
}

export function unsignedMask(bits: number): bigint { return mask(bits); }
export function signedValue(value: bigint, bits: number): bigint {
  const clipped = value & mask(bits);
  const sign = 1n << BigInt(bits - 1);
  return (clipped & sign) !== 0n ? clipped - (1n << BigInt(bits)) : clipped;
}
