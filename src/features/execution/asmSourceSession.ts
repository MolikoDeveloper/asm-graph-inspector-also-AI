import type { ProjectFile } from '../project/model';
import { SparseVirtualMemory } from './memory';
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionEvent,
  type ExecutionInstructionSnapshot,
  type ExecutionPolicy,
  type ExecutionSnapshot,
  type ExecutionStatus,
  type ExecutionSupport
} from './model';
import { isRegisterName, registerWidth, signedValue, unsignedMask, X86RegisterFile } from './registers';

const CODE_BASE = 0x0010_0000;
const CODE_STRIDE = 0x10;
const DATA_BASE = 0x0020_0000;
const STACK_TOP = 0x0000_7fff_ffff_f000;
const FLAG_CF = 0;
const FLAG_PF = 2;
const FLAG_ZF = 6;
const FLAG_SF = 7;
const FLAG_DF = 10;
const FLAG_OF = 11;
const MASK64 = (1n << 64n) - 1n;
const SIZE_PREFIXES: Record<string, number> = { byte: 8, word: 16, dword: 32, qword: 64 };

interface SourceInstruction extends ExecutionInstructionSnapshot {
  nodeId: string;
  line: number;
  raw: string;
  nextAddress: number;
}

interface SourceProgram {
  instructions: SourceInstruction[];
  byAddress: Map<number, SourceInstruction>;
  symbols: Map<string, bigint>;
  data: Uint8Array;
  entry: number;
}

type AddressTerm =
  | { kind: 'register'; name: string; scale: bigint; sign: 1n | -1n }
  | { kind: 'value'; value: bigint; sign: 1n | -1n };

type SourceOperand =
  | { kind: 'register'; name: string; bits: number }
  | { kind: 'immediate'; value: bigint; bits: number }
  | { kind: 'memory'; bits: number | null; terms: AddressTerm[] };

function appendEvent(events: ExecutionEvent[], event: ExecutionEvent): void {
  events.push(event);
  if (events.length > 600) events.splice(0, events.length - 600);
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ';') return line.slice(0, index);
  }
  return line;
}

function splitCommaList(value: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let bracketDepth = 0;
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      current += char;
      if (char === '\\' && index + 1 < value.length) current += value[++index];
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth -= 1;
    if (char === ',' && bracketDepth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() || value.includes(',')) parts.push(current.trim());
  return parts;
}

function parseInteger(token: string): bigint | null {
  const clean = token.trim().replace(/_/g, '');
  if (!clean) return null;
  try {
    if (/^[+-]?0x[0-9a-f]+$/i.test(clean)) return BigInt(clean);
    if (/^[+-]?0b[01]+$/i.test(clean)) return BigInt(clean);
    if (/^[+-]?\d+$/.test(clean)) return BigInt(clean);
  } catch { return null; }
  return null;
}

function decodeStringLiteral(token: string): Uint8Array | null {
  const trimmed = token.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return null;
  let result = '';
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    if (char !== '\\' || index + 1 >= trimmed.length - 1) { result += char; continue; }
    const escaped = trimmed[++index];
    if (escaped === 'n') result += '\n';
    else if (escaped === 'r') result += '\r';
    else if (escaped === 't') result += '\t';
    else if (escaped === '0') result += '\0';
    else result += escaped;
  }
  return new TextEncoder().encode(result);
}

function encodeScalar(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let remaining = value;
  for (let index = 0; index < bytes; index += 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function parseDataDirective(mnemonic: string, args: string): Uint8Array | null {
  const unit = mnemonic === 'db' ? 1 : mnemonic === 'dw' ? 2 : mnemonic === 'dd' ? 4 : mnemonic === 'dq' ? 8 : 0;
  if (!unit) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const token of splitCommaList(args)) {
    const string = decodeStringLiteral(token);
    if (string) {
      if (unit !== 1) throw new Error(`${mnemonic} string literals are only supported for db in the source sandbox.`);
      chunks.push(string);
      total += string.length;
      continue;
    }
    const integer = parseInteger(token);
    if (integer === null) throw new Error(`Unsupported ${mnemonic} value “${token}”.`);
    const encoded = encodeScalar(integer, unit);
    chunks.push(encoded);
    total += encoded.length;
  }
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  return result;
}

function parseReserveDirective(mnemonic: string, args: string): Uint8Array | null {
  const unit = mnemonic === 'resb' ? 1 : mnemonic === 'resw' ? 2 : mnemonic === 'resd' ? 4 : mnemonic === 'resq' ? 8 : 0;
  if (!unit) return null;
  const count = parseInteger(args);
  if (count === null || count < 0n || count > 16_777_216n) throw new Error(`Invalid ${mnemonic} count “${args}”.`);
  return new Uint8Array(Number(count) * unit);
}

function normalizeSection(value: string): 'text' | 'data' | 'other' {
  const name = value.trim().replace(/^\./, '').toLowerCase();
  if (name === 'text' || name === 'code') return 'text';
  if (name === 'data' || name === 'rodata' || name === 'bss') return 'data';
  return 'other';
}

function compileSource(file: ProjectFile, source: string): SourceProgram {
  const instructions: SourceInstruction[] = [];
  const symbols = new Map<string, bigint>();
  const pendingTextLabels: string[] = [];
  const dataChunks: Uint8Array[] = [];
  let dataSize = 0;
  let section: 'text' | 'data' | 'other' = 'text';

  const bindTextLabels = (address: number) => {
    for (const label of pendingTextLabels.splice(0)) {
      if (symbols.has(label)) throw new Error(`Duplicate symbol “${label}”.`);
      symbols.set(label, BigInt(address));
    }
  };

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    let code = stripComment(lines[index]).trim();
    if (!code || code.startsWith('%') || code.startsWith('#')) continue;

    const sectionMatch = code.match(/^(?:section|segment)\s+([^\s]+)/i);
    if (sectionMatch) { section = normalizeSection(sectionMatch[1]); continue; }
    if (/^(?:bits|use64)\b/i.test(code)) {
      if (/^bits\s+(16|32)\b/i.test(code) || /^use(?:16|32)\b/i.test(code)) throw new Error(`Line ${line}: source execution only supports x86-64 mode.`);
      continue;
    }
    if (/^(?:global|extern|default|align|org|cpu)\b/i.test(code)) continue;

    let label: string | null = null;
    const labelMatch = code.match(/^([.$A-Za-z_][\w.$@?]*):\s*(.*)$/);
    if (labelMatch) {
      label = labelMatch[1];
      code = labelMatch[2].trim();
      if (!code) {
        if (section === 'data') {
          if (symbols.has(label)) throw new Error(`Duplicate symbol “${label}”.`);
          symbols.set(label, BigInt(DATA_BASE + dataSize));
        } else pendingTextLabels.push(label);
        continue;
      }
    }

    const equMatch = code.match(/^([.$A-Za-z_][\w.$@?]*)\s+equ\s+(.+)$/i);
    if (equMatch) {
      const [, name, expression] = equMatch;
      const direct = parseInteger(expression);
      if (direct === null) throw new Error(`Line ${line}: only integer EQU values are supported by the source sandbox.`);
      if (symbols.has(name)) throw new Error(`Duplicate symbol “${name}”.`);
      symbols.set(name, direct);
      continue;
    }

    const directive = code.match(/^(db|dw|dd|dq|resb|resw|resd|resq)\b\s*(.*)$/i);
    if (directive) {
      const mnemonic = directive[1].toLowerCase();
      const bytes = parseDataDirective(mnemonic, directive[2]) ?? parseReserveDirective(mnemonic, directive[2]);
      if (!bytes) throw new Error(`Line ${line}: unsupported data directive ${mnemonic}.`);
      if (label) {
        if (symbols.has(label)) throw new Error(`Duplicate symbol “${label}”.`);
        symbols.set(label, BigInt(DATA_BASE + dataSize));
      }
      dataChunks.push(bytes);
      dataSize += bytes.length;
      continue;
    }

    if (section === 'data') throw new Error(`Line ${line}: instruction-like text appears in a data section.`);
    if (section === 'other') continue;

    const instructionMatch = code.match(/^([A-Za-z][\w.]*)\s*(.*?)\s*$/);
    if (!instructionMatch) throw new Error(`Line ${line}: unsupported assembly syntax.`);
    const address = CODE_BASE + instructions.length * CODE_STRIDE;
    bindTextLabels(address);
    if (label) {
      if (symbols.has(label)) throw new Error(`Duplicate symbol “${label}”.`);
      symbols.set(label, BigInt(address));
    }
    const mnemonic = instructionMatch[1].toLowerCase();
    const operands = instructionMatch[2].trim();
    instructions.push({
      address,
      endAddress: address + CODE_STRIDE,
      nextAddress: address + CODE_STRIDE,
      mnemonic,
      operands,
      line,
      nodeId: `${file.id}:insn:${line}`,
      raw: code
    });
  }

  bindTextLabels(CODE_BASE + instructions.length * CODE_STRIDE);
  if (!instructions.length) throw new Error('No executable ASM instructions were found.');

  const data = new Uint8Array(dataSize);
  let cursor = 0;
  for (const chunk of dataChunks) { data.set(chunk, cursor); cursor += chunk.length; }
  const byAddress = new Map(instructions.map((instruction) => [instruction.address, instruction]));
  const entrySymbol = symbols.get('_start') ?? symbols.get('main');
  const entry = entrySymbol !== undefined && byAddress.has(Number(entrySymbol)) ? Number(entrySymbol) : instructions[0].address;
  return { instructions, byAddress, symbols, data, entry };
}

function splitSignedTerms(expression: string): Array<{ sign: 1n | -1n; text: string }> {
  const terms: Array<{ sign: 1n | -1n; text: string }> = [];
  let sign: 1n | -1n = 1n;
  let start = 0;
  for (let index = 0; index <= expression.length; index += 1) {
    const char = expression[index];
    if (index === expression.length || ((char === '+' || char === '-') && index > start)) {
      const text = expression.slice(start, index).trim();
      if (text) terms.push({ sign, text });
      sign = char === '-' ? -1n : 1n;
      start = index + 1;
    } else if (index === start && char === '-') {
      sign = -1n;
      start += 1;
    } else if (index === start && char === '+') {
      sign = 1n;
      start += 1;
    }
  }
  return terms;
}

function resolveValue(token: string, symbols: Map<string, bigint>): bigint {
  const integer = parseInteger(token);
  if (integer !== null) return integer;
  const symbol = symbols.get(token.trim());
  if (symbol !== undefined) return symbol;
  throw new Error(`Unknown source symbol or immediate “${token}”.`);
}

function parseAddressExpression(expression: string, symbols: Map<string, bigint>): AddressTerm[] {
  const normalized = expression.replace(/^rel\s+/i, '').trim();
  const terms: AddressTerm[] = [];
  for (const term of splitSignedTerms(normalized)) {
    const scaleMatch = term.text.match(/^([A-Za-z][\w]*)\s*\*\s*(1|2|4|8)$/);
    if (scaleMatch && isRegisterName(scaleMatch[1])) {
      terms.push({ kind: 'register', name: scaleMatch[1].toLowerCase(), scale: BigInt(scaleMatch[2]), sign: term.sign });
      continue;
    }
    if (isRegisterName(term.text)) {
      terms.push({ kind: 'register', name: term.text.toLowerCase(), scale: 1n, sign: term.sign });
      continue;
    }
    terms.push({ kind: 'value', value: resolveValue(term.text, symbols), sign: term.sign });
  }
  if (!terms.length) throw new Error(`Empty memory expression [${expression}].`);
  return terms;
}

function parseOperand(text: string, symbols: Map<string, bigint>): SourceOperand {
  let value = text.trim();
  let explicitBits: number | null = null;
  const sizeMatch = value.match(/^(byte|word|dword|qword)\s+(?:ptr\s+)?(.+)$/i);
  if (sizeMatch) {
    explicitBits = SIZE_PREFIXES[sizeMatch[1].toLowerCase()];
    value = sizeMatch[2].trim();
  }
  if (isRegisterName(value)) return { kind: 'register', name: value.toLowerCase(), bits: registerWidth(value) ?? 64 };
  const memoryMatch = value.match(/^\[(.*)]$/);
  if (memoryMatch) return { kind: 'memory', bits: explicitBits, terms: parseAddressExpression(memoryMatch[1], symbols) };
  return { kind: 'immediate', value: resolveValue(value, symbols), bits: explicitBits ?? 64 };
}

function resolveAddress(operand: Extract<SourceOperand, { kind: 'memory' }>, registers: X86RegisterFile): bigint {
  let result = 0n;
  for (const term of operand.terms) {
    const value = term.kind === 'register' ? registers.read(term.name) * term.scale : term.value;
    result += term.sign * value;
  }
  return result & MASK64;
}

function operandBits(operand: SourceOperand | undefined, fallback = 64): number {
  if (!operand) return fallback;
  if (operand.kind === 'memory') return operand.bits ?? fallback;
  return operand.bits;
}

function readOperand(memory: SparseVirtualMemory, registers: X86RegisterFile, operand: SourceOperand, widthHint = 64): bigint {
  if (operand.kind === 'register') return registers.read(operand.name);
  if (operand.kind === 'immediate') return operand.value;
  const bits = operand.bits ?? widthHint;
  if (bits % 8 !== 0) throw new Error(`Unsupported memory width ${bits}.`);
  return memory.readUnsigned(resolveAddress(operand, registers), bits / 8);
}

function writeOperand(memory: SparseVirtualMemory, registers: X86RegisterFile, operand: SourceOperand, value: bigint, widthHint = 64): void {
  if (operand.kind === 'register') { registers.write(operand.name, value); return; }
  if (operand.kind === 'memory') {
    const bits = operand.bits ?? widthHint;
    if (bits % 8 !== 0) throw new Error(`Unsupported memory width ${bits}.`);
    memory.writeUnsigned(resolveAddress(operand, registers), bits / 8, value);
    return;
  }
  throw new Error('Immediate operands are not writable.');
}

function parityEven(byte: number): boolean {
  let value = byte & 0xff;
  value ^= value >> 4;
  value &= 0xf;
  return ((0x6996 >> value) & 1) === 0;
}

function setCommonFlags(registers: X86RegisterFile, result: bigint, bits: number): bigint {
  const clipped = result & unsignedMask(bits);
  registers.setFlag(FLAG_ZF, clipped === 0n);
  registers.setFlag(FLAG_SF, (clipped & (1n << BigInt(bits - 1))) !== 0n);
  registers.setFlag(FLAG_PF, parityEven(Number(clipped & 0xffn)));
  return clipped;
}

function setLogicFlags(registers: X86RegisterFile, result: bigint, bits: number): bigint {
  const clipped = setCommonFlags(registers, result, bits);
  registers.setFlag(FLAG_CF, false);
  registers.setFlag(FLAG_OF, false);
  return clipped;
}

function setAddFlags(registers: X86RegisterFile, left: bigint, right: bigint, result: bigint, bits: number): bigint {
  const mask = unsignedMask(bits);
  const a = left & mask;
  const b = right & mask;
  const clipped = setCommonFlags(registers, result, bits);
  registers.setFlag(FLAG_CF, a + b > mask);
  const sign = 1n << BigInt(bits - 1);
  registers.setFlag(FLAG_OF, (~(a ^ b) & (a ^ clipped) & sign) !== 0n);
  return clipped;
}

function setSubFlags(registers: X86RegisterFile, left: bigint, right: bigint, result: bigint, bits: number): bigint {
  const mask = unsignedMask(bits);
  const a = left & mask;
  const b = right & mask;
  const clipped = setCommonFlags(registers, result, bits);
  registers.setFlag(FLAG_CF, a < b);
  const sign = 1n << BigInt(bits - 1);
  registers.setFlag(FLAG_OF, ((a ^ b) & (a ^ clipped) & sign) !== 0n);
  return clipped;
}

function branchTaken(registers: X86RegisterFile, mnemonic: string): boolean | null {
  const cf = registers.getFlag(FLAG_CF);
  const pf = registers.getFlag(FLAG_PF);
  const zf = registers.getFlag(FLAG_ZF);
  const sf = registers.getFlag(FLAG_SF);
  const of = registers.getFlag(FLAG_OF);
  switch (mnemonic) {
    case 'je': case 'jz': return zf;
    case 'jne': case 'jnz': return !zf;
    case 'ja': case 'jnbe': return !cf && !zf;
    case 'jae': case 'jnb': case 'jnc': return !cf;
    case 'jb': case 'jc': case 'jnae': return cf;
    case 'jbe': case 'jna': return cf || zf;
    case 'jg': case 'jnle': return !zf && sf === of;
    case 'jge': case 'jnl': return sf === of;
    case 'jl': case 'jnge': return sf !== of;
    case 'jle': case 'jng': return zf || sf !== of;
    case 'js': return sf;
    case 'jns': return !sf;
    case 'jo': return of;
    case 'jno': return !of;
    case 'jp': case 'jpe': return pf;
    case 'jnp': case 'jpo': return !pf;
    default: return null;
  }
}

export function asmSourceExecutionSupport(file: ProjectFile, source: string): ExecutionSupport {
  const reasons: string[] = [];
  if (file.kind !== 'text' || file.language !== 'asm') reasons.push('Raw ASM execution requires an ASM source file.');
  if (!source.trim()) reasons.push('ASM source is empty.');
  if (!reasons.length) {
    try { compileSource(file, source); }
    catch (error: unknown) { reasons.push(error instanceof Error ? error.message : String(error)); }
  }
  return {
    supported: reasons.length === 0,
    provider: reasons.length ? null : 'asm-source-x86-64',
    reasons,
    notes: reasons.length ? [] : [
      'Raw ASM runs in the source-semantic x86-64 sandbox; it does not require ELF, ld-linux or libc.',
      'Instruction addresses are synthetic source PCs, not assembler byte offsets.',
      'Linux Lite currently virtualizes read(0), write(1/2), exit(60) and exit_group(231); other syscalls trap explicitly.'
    ]
  };
}

export class AsmSourceExecutionSession {
  private statusValue: ExecutionStatus = 'ready';
  private instructionCountValue = 0;
  private lastInstructionValue: SourceInstruction | null = null;
  private stdoutValue = '';
  private stderrValue = '';
  private exitCodeValue: number | null = null;
  private trapReasonValue: string | null = null;
  private eventsValue: ExecutionEvent[] = [];
  private stdinBytes: Uint8Array;
  private stdinCursor = 0;
  readonly registers = new X86RegisterFile();
  readonly memory: SparseVirtualMemory;
  readonly program: SourceProgram;

  constructor(
    readonly file: ProjectFile,
    readonly source: string,
    readonly policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
  ) {
    const support = asmSourceExecutionSupport(file, source);
    if (!support.supported) throw new Error(support.reasons.join(' '));
    this.program = compileSource(file, source);
    this.memory = new SparseVirtualMemory(policy.maxMappedBytes);
    const codeBytes = Math.max(CODE_STRIDE, this.program.instructions.length * CODE_STRIDE);
    this.memory.map(CODE_BASE, codeBytes, { read: true, write: false, execute: true }, 'ASM source code');
    if (this.program.data.length) {
      this.memory.map(DATA_BASE, Math.max(4096, this.program.data.length), { read: true, write: true, execute: false }, 'ASM data');
      this.memory.load(DATA_BASE, this.program.data);
    }
    const stackBase = STACK_TOP - policy.stackBytes;
    this.memory.map(stackBase, policy.stackBytes, { read: true, write: true, execute: false }, 'ASM stack');
    this.registers.write('rsp', BigInt(STACK_TOP - 16));
    this.registers.write('rip', BigInt(this.program.entry));
    this.stdinBytes = new TextEncoder().encode(policy.stdin);
    appendEvent(this.eventsValue, { kind: 'prepared', message: `Prepared ${file.name} as raw x86-64 source; entry source-PC=0x${this.program.entry.toString(16)}.` });
  }

  dispose(): void {}
  get status(): ExecutionStatus { return this.statusValue; }
  pause(): void { if (this.statusValue === 'running') this.statusValue = 'paused'; }
  markRunning(): void { if (this.statusValue === 'ready' || this.statusValue === 'paused') this.statusValue = 'running'; }

  runSlice(maxInstructions = 500): ExecutionSnapshot {
    this.markRunning();
    for (let index = 0; index < maxInstructions && this.statusValue === 'running'; index += 1) this.step();
    return this.snapshot();
  }

  snapshot(): ExecutionSnapshot {
    return {
      status: this.statusValue,
      targetFileId: this.file.id,
      targetName: this.file.name,
      imageKind: null,
      provider: 'asm-source-x86-64',
      instructionCount: this.instructionCountValue,
      registers: this.registers.snapshot(),
      lastInstruction: this.lastInstructionValue,
      stdout: this.stdoutValue,
      stderr: this.stderrValue,
      exitCode: this.exitCodeValue,
      trapReason: this.trapReasonValue,
      providerDiagnostics: [],
      events: [...this.eventsValue]
    };
  }

  private trap(reason: string): void {
    this.statusValue = 'trapped';
    this.trapReasonValue = reason;
    appendEvent(this.eventsValue, { kind: 'trap', reason });
  }

  private halt(reason: string): void {
    this.statusValue = 'halted';
    appendEvent(this.eventsValue, { kind: 'halt', reason });
  }

  private exit(code: number): void {
    this.statusValue = 'exited';
    this.exitCodeValue = code;
    appendEvent(this.eventsValue, { kind: 'exit', code });
  }

  private push(value: bigint): void {
    const rsp = (this.registers.read('rsp') - 8n) & MASK64;
    this.registers.write('rsp', rsp);
    this.memory.writeUnsigned(rsp, 8, value);
  }

  private pop(): bigint {
    const rsp = this.registers.read('rsp');
    const value = this.memory.readUnsigned(rsp, 8);
    this.registers.write('rsp', rsp + 8n);
    return value;
  }

  private syscall(): void {
    if (this.policy.syscallPolicy === 'none') throw new Error('Linux Lite syscalls are disabled by execution policy.');
    const number = Number(this.registers.read('rax'));
    if (number === 0) {
      const fd = Number(this.registers.read('rdi'));
      const address = this.registers.read('rsi');
      const requested = Number(this.registers.read('rdx'));
      if (fd !== 0) throw new Error(`Linux Lite read only supports fd 0; received fd ${fd}.`);
      const available = Math.max(0, Math.min(requested, this.stdinBytes.length - this.stdinCursor));
      const chunk = this.stdinBytes.subarray(this.stdinCursor, this.stdinCursor + available);
      this.memory.write(address, chunk);
      this.stdinCursor += available;
      this.registers.write('rax', BigInt(available));
      appendEvent(this.eventsValue, { kind: 'syscall', number, name: 'read', detail: `fd=0 count=${available}` });
      return;
    }
    if (number === 1) {
      const fd = Number(this.registers.read('rdi'));
      const address = this.registers.read('rsi');
      const count = Number(this.registers.read('rdx'));
      if (count < 0 || count > 16 * 1024 * 1024) throw new Error(`Linux Lite write count ${count} exceeds the sandbox limit.`);
      const text = new TextDecoder().decode(this.memory.read(address, count));
      if (fd === 1) {
        this.stdoutValue += text;
        appendEvent(this.eventsValue, { kind: 'stdout', text });
      } else if (fd === 2) {
        this.stderrValue += text;
        appendEvent(this.eventsValue, { kind: 'stderr', text });
      } else throw new Error(`Linux Lite write only supports fd 1/2; received fd ${fd}.`);
      this.registers.write('rax', BigInt(count));
      appendEvent(this.eventsValue, { kind: 'syscall', number, name: 'write', detail: `fd=${fd} count=${count}` });
      return;
    }
    if (number === 60 || number === 231) {
      const code = Number(this.registers.read('rdi') & 0xffn);
      appendEvent(this.eventsValue, { kind: 'syscall', number, name: number === 60 ? 'exit' : 'exit_group', detail: `code=${code}` });
      this.exit(code);
      return;
    }
    throw new Error(`Linux Lite syscall ${number} is not implemented by the raw ASM sandbox.`);
  }

  private execute(instruction: SourceInstruction): void {
    const operands = instruction.operands ? splitCommaList(instruction.operands).map((operand) => parseOperand(operand, this.program.symbols)) : [];
    const mnemonic = instruction.mnemonic;
    const nextRip = BigInt(instruction.nextAddress);
    this.registers.write('rip', nextRip);

    if (mnemonic === 'nop' || mnemonic === 'pause' || mnemonic === 'endbr64' || mnemonic === 'endbr32') return;
    if (mnemonic === 'hlt') { this.halt('HLT instruction'); return; }
    if (mnemonic === 'cld') { this.registers.setFlag(FLAG_DF, false); return; }
    if (mnemonic === 'std') { this.registers.setFlag(FLAG_DF, true); return; }

    if (mnemonic === 'mov' || mnemonic === 'movabs') {
      if (operands.length !== 2) throw new Error(`${mnemonic} requires two operands.`);
      const bits = operandBits(operands[0], operandBits(operands[1]));
      writeOperand(this.memory, this.registers, operands[0], readOperand(this.memory, this.registers, operands[1], bits), bits);
      return;
    }
    if (mnemonic === 'movzx' || mnemonic === 'movsx' || mnemonic === 'movsxd') {
      if (operands.length !== 2) throw new Error(`${mnemonic} requires two operands.`);
      const sourceBits = operandBits(operands[1], mnemonic === 'movsxd' ? 32 : 8);
      const raw = readOperand(this.memory, this.registers, operands[1], sourceBits);
      const value = mnemonic === 'movzx' ? raw & unsignedMask(sourceBits) : signedValue(raw, sourceBits);
      writeOperand(this.memory, this.registers, operands[0], value, operandBits(operands[0]));
      return;
    }
    if (mnemonic === 'lea') {
      if (operands.length !== 2 || operands[1].kind !== 'memory') throw new Error('lea requires a memory expression as its source.');
      writeOperand(this.memory, this.registers, operands[0], resolveAddress(operands[1], this.registers), operandBits(operands[0]));
      return;
    }
    if (mnemonic === 'push') { if (!operands[0]) throw new Error('push requires one operand.'); this.push(readOperand(this.memory, this.registers, operands[0], 64)); return; }
    if (mnemonic === 'pop') { if (!operands[0]) throw new Error('pop requires one operand.'); writeOperand(this.memory, this.registers, operands[0], this.pop(), 64); return; }
    if (mnemonic === 'leave') { this.registers.write('rsp', this.registers.read('rbp')); this.registers.write('rbp', this.pop()); return; }

    if (mnemonic === 'xor' || mnemonic === 'and' || mnemonic === 'or' || mnemonic === 'test') {
      if (operands.length !== 2) throw new Error(`${mnemonic} requires two operands.`);
      const bits = operandBits(operands[0]);
      const left = readOperand(this.memory, this.registers, operands[0], bits);
      const right = readOperand(this.memory, this.registers, operands[1], bits);
      const result = mnemonic === 'xor' ? left ^ right : mnemonic === 'and' || mnemonic === 'test' ? left & right : left | right;
      const clipped = setLogicFlags(this.registers, result, bits);
      if (mnemonic !== 'test') writeOperand(this.memory, this.registers, operands[0], clipped, bits);
      return;
    }
    if (mnemonic === 'add' || mnemonic === 'sub' || mnemonic === 'cmp') {
      if (operands.length !== 2) throw new Error(`${mnemonic} requires two operands.`);
      const bits = operandBits(operands[0]);
      const left = readOperand(this.memory, this.registers, operands[0], bits);
      const right = readOperand(this.memory, this.registers, operands[1], bits);
      const result = mnemonic === 'add' ? left + right : left - right;
      const clipped = mnemonic === 'add' ? setAddFlags(this.registers, left, right, result, bits) : setSubFlags(this.registers, left, right, result, bits);
      if (mnemonic !== 'cmp') writeOperand(this.memory, this.registers, operands[0], clipped, bits);
      return;
    }
    if (mnemonic === 'inc' || mnemonic === 'dec') {
      if (!operands[0]) throw new Error(`${mnemonic} requires one operand.`);
      const oldCf = this.registers.getFlag(FLAG_CF);
      const bits = operandBits(operands[0]);
      const value = readOperand(this.memory, this.registers, operands[0], bits);
      const result = mnemonic === 'inc' ? setAddFlags(this.registers, value, 1n, value + 1n, bits) : setSubFlags(this.registers, value, 1n, value - 1n, bits);
      this.registers.setFlag(FLAG_CF, oldCf);
      writeOperand(this.memory, this.registers, operands[0], result, bits);
      return;
    }
    if (mnemonic === 'neg' || mnemonic === 'not') {
      if (!operands[0]) throw new Error(`${mnemonic} requires one operand.`);
      const bits = operandBits(operands[0]);
      const value = readOperand(this.memory, this.registers, operands[0], bits);
      const result = mnemonic === 'not' ? (~value) & unsignedMask(bits) : setSubFlags(this.registers, 0n, value, -value, bits);
      writeOperand(this.memory, this.registers, operands[0], result, bits);
      return;
    }

    if (mnemonic === 'call') {
      if (!operands[0] || operands[0].kind !== 'immediate') throw new Error('Raw ASM call currently requires a direct label/address target.');
      this.push(nextRip);
      this.registers.write('rip', operands[0].value);
      return;
    }
    if (mnemonic === 'ret' || mnemonic === 'retq') { this.registers.write('rip', this.pop()); return; }
    if (mnemonic === 'jmp') {
      if (!operands[0] || operands[0].kind !== 'immediate') throw new Error('Raw ASM jmp currently requires a direct label/address target.');
      this.registers.write('rip', operands[0].value);
      return;
    }
    if (mnemonic.startsWith('j')) {
      const taken = branchTaken(this.registers, mnemonic);
      if (taken === null) throw new Error(`Conditional transfer ${mnemonic} is not implemented by the raw ASM sandbox.`);
      if (taken) {
        if (!operands[0] || operands[0].kind !== 'immediate') throw new Error(`${mnemonic} requires a direct label/address target.`);
        this.registers.write('rip', operands[0].value);
      }
      return;
    }
    if (mnemonic === 'syscall') {
      this.registers.write('rcx', nextRip);
      this.registers.write('r11', this.registers.read('rflags'));
      this.syscall();
      return;
    }

    throw new Error(`Instruction ${mnemonic}${instruction.operands ? ` ${instruction.operands}` : ''} is not implemented by the raw ASM source provider.`);
  }

  step(): ExecutionSnapshot {
    if (this.statusValue === 'exited' || this.statusValue === 'halted' || this.statusValue === 'trapped') return this.snapshot();
    if (this.instructionCountValue >= this.policy.maxInstructions) {
      this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
      return this.snapshot();
    }
    try {
      const address = Number(this.registers.read('rip'));
      const instruction = this.program.byAddress.get(address);
      if (!instruction) throw new Error(`No source instruction exists at source-PC 0x${address.toString(16)}.`);
      this.lastInstructionValue = instruction;
      this.instructionCountValue += 1;
      appendEvent(this.eventsValue, { kind: 'instruction', address, mnemonic: instruction.mnemonic, operands: instruction.operands, line: instruction.line, nodeId: instruction.nodeId });
      this.execute(instruction);
      const postStatus = this.statusValue as ExecutionStatus;
      if (postStatus !== 'exited' && postStatus !== 'halted' && postStatus !== 'trapped' && postStatus !== 'running') this.statusValue = 'paused';
    } catch (error: unknown) {
      this.trap(error instanceof Error ? error.message : String(error));
    }
    return this.snapshot();
  }
}
