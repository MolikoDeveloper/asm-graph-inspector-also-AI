import type { CanonicalInstruction, CanonicalMemoryOperand } from '../../binary/model';
import type { GraphNode } from '../model';
import type { DataflowInstruction } from './model';

export const SYSV_ARGUMENT_REGS = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'] as const;
export const LINUX_SYSCALL_ARGUMENT_REGS = ['rdi', 'rsi', 'rdx', 'r10', 'r8', 'r9'] as const;
export const SYSV_CALLER_SAVED = ['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11'] as const;
export const SYSCALL_CLOBBERS = ['rcx', 'r11'] as const;

export const LINUX_X86_64_SYSCALLS = new Map<number, { name: string; args: number }>([
  [0, { name: 'read', args: 3 }],
  [1, { name: 'write', args: 3 }],
  [2, { name: 'open', args: 3 }],
  [3, { name: 'close', args: 1 }],
  [9, { name: 'mmap', args: 6 }],
  [10, { name: 'mprotect', args: 3 }],
  [11, { name: 'munmap', args: 2 }],
  [12, { name: 'brk', args: 1 }],
  [16, { name: 'ioctl', args: 3 }],
  [39, { name: 'getpid', args: 0 }],
  [56, { name: 'clone', args: 5 }],
  [57, { name: 'fork', args: 0 }],
  [59, { name: 'execve', args: 3 }],
  [60, { name: 'exit', args: 1 }],
  [61, { name: 'wait4', args: 4 }],
  [62, { name: 'kill', args: 2 }],
  [63, { name: 'uname', args: 1 }],
  [72, { name: 'fcntl', args: 3 }],
  [158, { name: 'arch_prctl', args: 2 }],
  [202, { name: 'futex', args: 6 }],
  [218, { name: 'set_tid_address', args: 1 }],
  [231, { name: 'exit_group', args: 1 }],
  [257, { name: 'openat', args: 4 }],
  [262, { name: 'newfstatat', args: 4 }],
  [273, { name: 'set_robust_list', args: 2 }],
  [302, { name: 'prlimit64', args: 4 }],
  [318, { name: 'getrandom', args: 3 }]
]);

const REGISTER_ALIASES = (() => {
  const map = new Map<string, string>();
  const add = (canonical: string, names: string[]) => names.forEach((name) => map.set(name, canonical));
  add('rax', ['rax', 'eax', 'ax', 'al', 'ah']);
  add('rbx', ['rbx', 'ebx', 'bx', 'bl', 'bh']);
  add('rcx', ['rcx', 'ecx', 'cx', 'cl', 'ch']);
  add('rdx', ['rdx', 'edx', 'dx', 'dl', 'dh']);
  add('rsi', ['rsi', 'esi', 'si', 'sil']);
  add('rdi', ['rdi', 'edi', 'di', 'dil']);
  add('rbp', ['rbp', 'ebp', 'bp', 'bpl']);
  add('rsp', ['rsp', 'esp', 'sp', 'spl']);
  add('rip', ['rip', 'eip']);
  for (let index = 8; index <= 15; index += 1) add(`r${index}`, [`r${index}`, `r${index}d`, `r${index}w`, `r${index}b`]);
  return map;
})();

export function canonicalRegister(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return REGISTER_ALIASES.get(raw.toLowerCase().replace(/^%/, '')) ?? null;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function splitOperands(text: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if ('[({'.includes(char)) depth += 1;
    if (']})'.includes(char)) depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() || text.includes(',')) result.push(current.trim());
  return result;
}

export function operandRegisters(text: string): string[] {
  const registers: string[] = [];
  for (const match of text.toLowerCase().matchAll(/%?([a-z][a-z0-9]*)/g)) {
    const register = canonicalRegister(match[1]);
    if (register && !registers.includes(register)) registers.push(register);
  }
  return registers;
}

export function directRegister(text: string): string | null {
  const token = text.trim().replace(/^%/, '');
  if (/[[\]()]/.test(token)) return null;
  return canonicalRegister(token);
}

export function parseInteger(text: string): string | null {
  const normalized = text.trim().replace(/^\$/, '');
  if (/^[+-]?0x[0-9a-f]+$/i.test(normalized) || /^[+-]?\d+$/.test(normalized)) return normalized.toLowerCase();
  return null;
}

export function sourceMemoryKey(operand: string): string | null {
  const raw = operand.toLowerCase().replace(/\s+/g, '').replace(/^(?:byte|word|dword|qword)(?:ptr)?/, '');
  let match = raw.match(/^\[(rbp|rsp|rip)([+-](?:0x[0-9a-f]+|\d+))?\]$/i);
  if (match) return `${match[1]}:${match[2] ?? '+0'}`;
  match = raw.match(/^([+-]?(?:0x[0-9a-f]+|\d+))?\(%?(rbp|rsp|rip)\)$/i);
  if (match) return `${match[2]}:${match[1] ?? '+0'}`;
  if (/\[|\(/.test(raw)) return `mem:${raw}`;
  return null;
}

export function canonicalMemoryKey(memory: CanonicalMemoryOperand): string {
  const base = canonicalRegister(memory.base) ?? memory.base ?? '';
  const index = canonicalRegister(memory.index) ?? memory.index ?? '';
  const displacement = String(memory.displacement);
  return `mem:${base || 'abs'}:${index || '-'}:${memory.scale}:${displacement}:${memory.width}`;
}

export function sourceAccess(mnemonic: string, operandsText: string): {
  reads: string[];
  writes: string[];
  memoryReads: string[];
  memoryWrites: string[];
} {
  const mnemonicLower = mnemonic.toLowerCase();
  const operands = splitOperands(operandsText);
  const att = operandsText.includes('%') || operandsText.includes('$');
  const ordered = att && operands.length >= 2 ? [...operands].reverse() : operands;
  const destination = ordered[0] ?? '';
  const source = ordered[1] ?? '';
  const reads = new Set<string>();
  const writes = new Set<string>();
  const memoryReads = new Set<string>();
  const memoryWrites = new Set<string>();
  const addOperandReads = (operand: string) => operandRegisters(operand).forEach((register) => reads.add(register));
  const destinationRegister = directRegister(destination);
  const destinationMemory = sourceMemoryKey(destination);
  const sourceMemory = sourceMemoryKey(source);

  if (/^(?:mov|mov[a-z]*|movzx|movsx|movsxd)$/i.test(mnemonicLower)) {
    addOperandReads(source);
    if (sourceMemory) memoryReads.add(sourceMemory);
    if (destinationRegister) writes.add(destinationRegister);
    else if (destinationMemory) {
      addOperandReads(destination);
      memoryWrites.add(destinationMemory);
    }
  } else if (/^lea/.test(mnemonicLower)) {
    addOperandReads(source);
    if (destinationRegister) writes.add(destinationRegister);
  } else if (/^(?:cmp|test)/.test(mnemonicLower)) {
    operands.forEach(addOperandReads);
    operands.map(sourceMemoryKey).filter((value): value is string => Boolean(value)).forEach((key) => memoryReads.add(key));
  } else if (/^(?:add|sub|adc|sbb|and|or|xor|imul|shl|shr|sar|sal|rol|ror)/.test(mnemonicLower)) {
    addOperandReads(source);
    if (destinationRegister) {
      reads.add(destinationRegister);
      writes.add(destinationRegister);
    } else if (destinationMemory) {
      addOperandReads(destination);
      memoryReads.add(destinationMemory);
      memoryWrites.add(destinationMemory);
    }
  } else if (/^push/.test(mnemonicLower)) {
    addOperandReads(operands[0] ?? '');
    reads.add('rsp');
    writes.add('rsp');
    memoryWrites.add('stack:rsp');
  } else if (/^pop/.test(mnemonicLower)) {
    reads.add('rsp');
    writes.add('rsp');
    memoryReads.add('stack:rsp');
    const register = directRegister(operands[0] ?? '');
    if (register) writes.add(register);
  } else if (/^call/.test(mnemonicLower)) {
    SYSV_ARGUMENT_REGS.forEach((register) => reads.add(register));
    SYSV_CALLER_SAVED.forEach((register) => writes.add(register));
    operands.forEach(addOperandReads);
  } else if (mnemonicLower === 'syscall') {
    reads.add('rax');
    LINUX_SYSCALL_ARGUMENT_REGS.forEach((register) => reads.add(register));
    writes.add('rax');
    SYSCALL_CLOBBERS.forEach((register) => writes.add(register));
  } else if (/^ret/.test(mnemonicLower)) {
    reads.add('rsp');
    reads.add('rax');
    writes.add('rsp');
  } else {
    operands.forEach(addOperandReads);
    for (const operand of operands) {
      const memory = sourceMemoryKey(operand);
      if (memory) memoryReads.add(memory);
    }
  }
  return { reads: [...reads], writes: [...writes], memoryReads: [...memoryReads], memoryWrites: [...memoryWrites] };
}

export function fromCanonical(instruction: CanonicalInstruction): DataflowInstruction {
  return {
    id: `insn:${instruction.address.toString(16)}`,
    line: 0,
    address: instruction.address,
    mnemonic: instruction.mnemonic,
    operands: instruction.operands,
    kind: instruction.controlFlow === 'syscall' ? 'syscall' : instruction.controlFlow === 'call' ? 'call' : instruction.controlFlow === 'jump' ? 'branch' : 'instruction',
    registerReads: unique(instruction.registerReads.map(canonicalRegister).filter((value): value is string => Boolean(value))),
    registerWrites: unique(instruction.registerWrites.map(canonicalRegister).filter((value): value is string => Boolean(value))),
    memoryReads: unique(instruction.memoryOperands.filter((memory) => memory.access.read).map(canonicalMemoryKey)),
    memoryWrites: unique(instruction.memoryOperands.filter((memory) => memory.access.write).map(canonicalMemoryKey)),
    controlFlow: instruction.controlFlow
  };
}

export function fromSourceNode(node: GraphNode): DataflowInstruction | null {
  if (!node.mnemonic) return null;
  const access = sourceAccess(node.mnemonic, node.operands ?? '');
  const lower = node.mnemonic.toLowerCase();
  const controlFlow: DataflowInstruction['controlFlow'] = node.kind === 'syscall'
    ? 'syscall'
    : node.kind === 'call'
      ? 'call'
      : node.kind === 'branch'
        ? 'jump'
        : /^ret/.test(lower)
          ? 'return'
          : 'none';
  return {
    id: node.id,
    line: node.line,
    address: node.address ?? null,
    mnemonic: node.mnemonic,
    operands: node.operands ?? '',
    kind: node.kind === 'syscall' ? 'syscall' : node.kind === 'call' ? 'call' : node.kind === 'branch' ? 'branch' : 'instruction',
    registerReads: access.reads,
    registerWrites: access.writes,
    memoryReads: access.memoryReads,
    memoryWrites: access.memoryWrites,
    controlFlow
  };
}
