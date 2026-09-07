import type { CanonicalInstruction, CanonicalMemoryOperand, CanonicalOperand, LoadedImage } from '../binary/model';
import { createX86_64InstructionDecoder, type X86_64InstructionDecoder } from '../capstone/capstoneDecoder';
import type { CapstoneModule } from '../capstone/types';
import type { ProjectFile } from '../project/model';
import { loadElfExecutionMemory, numberAddress, SparseVirtualMemory } from './memory';
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionEvent,
  type ExecutionPolicy,
  type ExecutionSnapshot,
  type ExecutionStatus,
  type ExecutionSupport
} from './model';
import { signedValue, unsignedMask, X86RegisterFile } from './registers';

const FLAG_CF = 0;
const FLAG_PF = 2;
const FLAG_ZF = 6;
const FLAG_SF = 7;
const FLAG_DF = 10;
const FLAG_OF = 11;
const MASK64 = (1n << 64n) - 1n;

function scalar(value: number | string): bigint {
  try { return BigInt(value); }
  catch { throw new Error(`Cannot interpret scalar operand ${String(value)} as an integer.`); }
}

function operandBits(operand: CanonicalOperand | undefined, fallback = 64): number {
  const bytes = operand?.size ?? 0;
  return bytes > 0 ? Math.min(64, bytes * 8) : fallback;
}

function parityEven(byte: number): boolean {
  let value = byte & 0xff;
  value ^= value >> 4;
  value &= 0xf;
  return ((0x6996 >> value) & 1) === 0;
}

function appendEvent(events: ExecutionEvent[], event: ExecutionEvent): void {
  events.push(event);
  if (events.length > 300) events.splice(0, events.length - 300);
}

export function executionSupport(image: LoadedImage): ExecutionSupport {
  const reasons: string[] = [];
  const notes: string[] = [];
  if (image.architecture !== 'x86-64') reasons.push(`Architecture ${image.architecture} is not supported by the current process providers.`);
  if (image.kind !== 'executable' && image.kind !== 'pie-executable') {
    reasons.push(`Process Sandbox accepts ELF executables; image kind is ${image.kind}.`);
  }
  if (!image.segments.some((segment) => segment.executable && image.entry >= segment.virtualAddress && image.entry < segment.virtualAddress + segment.memorySize)) {
    reasons.push(`Entry point 0x${image.entry.toString(16)} is not inside an executable PT_LOAD mapping.`);
  }
  const dynamic = image.kind === 'pie-executable' || !!image.interpreter || image.neededLibraries.length > 0;
  const provider = reasons.length ? null : dynamic ? 'blink-process' : 'bounded-x86-64';
  if (provider === 'blink-process') {
    notes.push(`Dynamic Linux process execution will use the Blink/WASM Process Sandbox.`);
    if (image.interpreter) notes.push(`PT_INTERP ${image.interpreter} will be resolved inside the sandbox filesystem.`);
    if (image.neededLibraries.length) notes.push(`${image.neededLibraries.length} direct DT_NEEDED entr${image.neededLibraries.length === 1 ? 'y' : 'ies'} will be materialized from Global Dependencies.`);
  } else if (provider === 'bounded-x86-64') {
    notes.push('Static fixed-address ELF will use the bounded instruction provider.');
  }
  return { supported: reasons.length === 0, provider, reasons, notes };
}

interface OperandContext {
  instruction: CanonicalInstruction;
  memory: SparseVirtualMemory;
  registers: X86RegisterFile;
}

function effectiveAddress(context: OperandContext, memory: CanonicalMemoryOperand): bigint {
  if (memory.segment && memory.segment !== 'ds' && memory.segment !== 'ss' && memory.segment !== 'cs' && memory.segment !== 'es') {
    throw new Error(`Segment-relative memory via ${memory.segment} is not implemented by the browser execution provider.`);
  }
  let result = scalar(memory.displacement);
  if (memory.base) result += memory.base.toLowerCase() === 'rip' ? BigInt(context.instruction.endAddress) : context.registers.read(memory.base);
  if (memory.index) result += context.registers.read(memory.index) * BigInt(memory.scale || 1);
  return result & MASK64;
}

function readOperand(context: OperandContext, operand: CanonicalOperand): bigint {
  if (operand.kind === 'register') {
    if (!operand.register) throw new Error('Capstone returned a register operand without a register name.');
    return context.registers.read(operand.register);
  }
  if (operand.kind === 'immediate') return scalar(operand.value);
  if (operand.kind === 'memory') return context.memory.readUnsigned(effectiveAddress(context, operand.memory), Math.max(1, operand.size));
  throw new Error(`Operand kind ${operand.kind} cannot be read as an integer.`);
}

function writeOperand(context: OperandContext, operand: CanonicalOperand, value: bigint): void {
  if (operand.kind === 'register') {
    if (!operand.register) throw new Error('Capstone returned a register operand without a register name.');
    context.registers.write(operand.register, value);
    return;
  }
  if (operand.kind === 'memory') {
    context.memory.writeUnsigned(effectiveAddress(context, operand.memory), Math.max(1, operand.size), value);
    return;
  }
  throw new Error(`Operand kind ${operand.kind} is not writable.`);
}

function setCommonFlags(registers: X86RegisterFile, result: bigint, bits: number): bigint {
  const mask = unsignedMask(bits);
  const clipped = result & mask;
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
  const clippedLeft = left & mask;
  const clippedRight = right & mask;
  const clipped = setCommonFlags(registers, result, bits);
  registers.setFlag(FLAG_CF, clippedLeft + clippedRight > mask);
  const sign = 1n << BigInt(bits - 1);
  registers.setFlag(FLAG_OF, ((~(clippedLeft ^ clippedRight) & (clippedLeft ^ clipped) & sign) !== 0n));
  return clipped;
}

function setSubFlags(registers: X86RegisterFile, left: bigint, right: bigint, result: bigint, bits: number): bigint {
  const mask = unsignedMask(bits);
  const clippedLeft = left & mask;
  const clippedRight = right & mask;
  const clipped = setCommonFlags(registers, result, bits);
  registers.setFlag(FLAG_CF, clippedLeft < clippedRight);
  const sign = 1n << BigInt(bits - 1);
  registers.setFlag(FLAG_OF, (((clippedLeft ^ clippedRight) & (clippedLeft ^ clipped) & sign) !== 0n));
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

function resolveTransferTarget(context: OperandContext): bigint {
  const direct = context.instruction.directTarget;
  if (direct !== null) return BigInt(direct);
  const operand = context.instruction.operandDetails[0];
  if (!operand) throw new Error(`${context.instruction.mnemonic} has no resolvable transfer target.`);
  return readOperand(context, operand);
}

function initializeStack(memory: SparseVirtualMemory, registers: X86RegisterFile, stackTop: number, image: LoadedImage): void {
  const encoded = new TextEncoder().encode(`${image.sourcePath}\0`);
  let stringAddress = stackTop - encoded.byteLength;
  memory.write(stringAddress, encoded);
  stringAddress = Math.floor(stringAddress / 16) * 16;

  const words = [
    1n,
    BigInt(stackTop - encoded.byteLength),
    0n,
    0n,
    6n, 4096n,
    9n, BigInt(image.entry),
    0n, 0n
  ];
  let rsp = stringAddress - words.length * 8;
  rsp = Math.floor(rsp / 16) * 16;
  for (let index = 0; index < words.length; index += 1) memory.writeUnsigned(rsp + index * 8, 8, words[index]);
  registers.write('rsp', BigInt(rsp));
  registers.write('rdx', 0n);
}

export class X86ExecutionSession {
  private statusValue: ExecutionStatus = 'ready';
  private instructionCountValue = 0;
  private lastInstructionValue: CanonicalInstruction | null = null;
  private stdoutValue = '';
  private stderrValue = '';
  private exitCodeValue: number | null = null;
  private trapReasonValue: string | null = null;
  private eventsValue: ExecutionEvent[] = [];
  private stdinBytes: Uint8Array;
  private stdinCursor = 0;
  private readonly decoder: X86_64InstructionDecoder;
  readonly registers = new X86RegisterFile();
  readonly memory: SparseVirtualMemory;

  constructor(
    readonly file: ProjectFile,
    readonly image: LoadedImage,
    capstone: CapstoneModule,
    readonly policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
  ) {
    if (file.kind !== 'binary' || !file.bytes) throw new Error('Execution requires the authoritative bytes of a binary project file.');
    const support = executionSupport(image);
    if (!support.supported) throw new Error(support.reasons.join(' '));
    const loaded = loadElfExecutionMemory(image, file.bytes, policy);
    this.memory = loaded.memory;
    this.decoder = createX86_64InstructionDecoder(capstone);
    this.registers.write('rip', BigInt(image.entry));
    initializeStack(this.memory, this.registers, loaded.stackTop, image);
    this.stdinBytes = new TextEncoder().encode(policy.stdin);
    appendEvent(this.eventsValue, { kind: 'prepared', message: `Loaded ${file.name} at fixed ELF virtual addresses; entry=0x${image.entry.toString(16)}.` });
  }

  dispose(): void { this.decoder.close(); }

  get status(): ExecutionStatus { return this.statusValue; }

  pause(): void {
    if (this.statusValue === 'running') this.statusValue = 'paused';
  }

  markRunning(): void {
    if (this.statusValue === 'ready' || this.statusValue === 'paused') this.statusValue = 'running';
  }

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
      imageKind: this.image.kind,
      provider: 'bounded-x86-64',
      instructionCount: this.instructionCountValue,
      registers: this.registers.snapshot(),
      lastInstruction: this.lastInstructionValue,
      runtimeDisassembly: null,
      stdout: this.stdoutValue,
      stderr: this.stderrValue,
      exitCode: this.exitCodeValue,
      trapReason: this.trapReasonValue,
      providerDiagnostics: [],
      events: this.eventsValue.slice()
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

  private push(value: bigint): void {
    const rsp = (this.registers.read('rsp') - 8n) & MASK64;
    this.memory.writeUnsigned(rsp, 8, value);
    this.registers.write('rsp', rsp);
  }

  private pop(): bigint {
    const rsp = this.registers.read('rsp');
    const value = this.memory.readUnsigned(rsp, 8);
    this.registers.write('rsp', rsp + 8n);
    return value;
  }

  private syscall(): void {
    if (this.policy.syscallPolicy === 'none') throw new Error('Linux syscalls are disabled by execution policy.');
    const number = Number(this.registers.read('rax'));
    if (!Number.isSafeInteger(number)) throw new Error('Syscall number is outside the supported integer range.');

    if (number === 60 || number === 231) {
      const code = Number(this.registers.read('rdi') & 0xffn);
      appendEvent(this.eventsValue, { kind: 'syscall', number, name: number === 60 ? 'exit' : 'exit_group', detail: `code=${code}` });
      this.exitCodeValue = code;
      this.statusValue = 'exited';
      appendEvent(this.eventsValue, { kind: 'exit', code });
      return;
    }

    if (number === 1) {
      const fd = Number(this.registers.read('rdi'));
      const address = this.registers.read('rsi');
      const count = Number(this.registers.read('rdx'));
      if (!Number.isSafeInteger(count) || count < 0 || count > 1024 * 1024) throw new Error(`write count ${count} exceeds the execution IO limit.`);
      if (fd !== 1 && fd !== 2) throw new Error(`write(fd=${fd}) is outside the virtual stdout/stderr contract.`);
      const text = new TextDecoder().decode(this.memory.read(address, count));
      if (fd === 1) {
        this.stdoutValue += text;
        appendEvent(this.eventsValue, { kind: 'stdout', text });
      } else {
        this.stderrValue += text;
        appendEvent(this.eventsValue, { kind: 'stderr', text });
      }
      appendEvent(this.eventsValue, { kind: 'syscall', number, name: 'write', detail: `fd=${fd}, count=${count}` });
      this.registers.write('rax', BigInt(count));
      return;
    }

    if (number === 0) {
      const fd = Number(this.registers.read('rdi'));
      const address = this.registers.read('rsi');
      const count = Number(this.registers.read('rdx'));
      if (fd !== 0) throw new Error(`read(fd=${fd}) is outside the virtual stdin contract.`);
      if (!Number.isSafeInteger(count) || count < 0 || count > 1024 * 1024) throw new Error(`read count ${count} exceeds the execution IO limit.`);
      const available = Math.min(count, this.stdinBytes.length - this.stdinCursor);
      const chunk = this.stdinBytes.subarray(this.stdinCursor, this.stdinCursor + available);
      this.memory.write(address, chunk);
      this.stdinCursor += available;
      this.registers.write('rax', BigInt(available));
      appendEvent(this.eventsValue, { kind: 'syscall', number, name: 'read', detail: `fd=0, count=${available}` });
      return;
    }

    throw new Error(`Linux x86-64 syscall ${number} is not implemented by the bounded browser provider.`);
  }

  private execute(instruction: CanonicalInstruction): void {
    const context: OperandContext = { instruction, memory: this.memory, registers: this.registers };
    const operands = instruction.operandDetails;
    const mnemonic = instruction.mnemonic.toLowerCase();
    const nextRip = BigInt(instruction.endAddress);
    this.registers.write('rip', nextRip);

    if (mnemonic === 'nop' || mnemonic === 'endbr64' || mnemonic === 'endbr32') return;
    if (mnemonic === 'hlt') { this.halt('HLT instruction'); return; }
    if (mnemonic === 'cld') { this.registers.setFlag(FLAG_DF, false); return; }
    if (mnemonic === 'std') { this.registers.setFlag(FLAG_DF, true); return; }

    if (mnemonic === 'mov' || mnemonic === 'movabs') {
      if (operands.length < 2) throw new Error(`${mnemonic} requires two operands.`);
      writeOperand(context, operands[0], readOperand(context, operands[1]));
      return;
    }
    if (mnemonic === 'movzx') {
      if (operands.length < 2) throw new Error('movzx requires two operands.');
      writeOperand(context, operands[0], readOperand(context, operands[1]) & unsignedMask(operandBits(operands[1])));
      return;
    }
    if (mnemonic === 'movsx' || mnemonic === 'movsxd') {
      if (operands.length < 2) throw new Error(`${mnemonic} requires two operands.`);
      const bits = operandBits(operands[1], mnemonic === 'movsxd' ? 32 : 8);
      writeOperand(context, operands[0], signedValue(readOperand(context, operands[1]), bits));
      return;
    }
    if (mnemonic === 'lea') {
      if (operands.length < 2 || operands[1].kind !== 'memory') throw new Error('lea requires a memory-address operand.');
      writeOperand(context, operands[0], effectiveAddress(context, operands[1].memory));
      return;
    }
    if (mnemonic === 'xchg') {
      if (operands.length < 2) throw new Error('xchg requires two operands.');
      const left = readOperand(context, operands[0]);
      const right = readOperand(context, operands[1]);
      writeOperand(context, operands[0], right);
      writeOperand(context, operands[1], left);
      return;
    }

    if (mnemonic === 'push') {
      if (!operands[0]) throw new Error('push requires one operand.');
      this.push(readOperand(context, operands[0]));
      return;
    }
    if (mnemonic === 'pop') {
      if (!operands[0]) throw new Error('pop requires one operand.');
      writeOperand(context, operands[0], this.pop());
      return;
    }
    if (mnemonic === 'leave') {
      this.registers.write('rsp', this.registers.read('rbp'));
      this.registers.write('rbp', this.pop());
      return;
    }

    if (mnemonic === 'xor' || mnemonic === 'and' || mnemonic === 'or') {
      if (operands.length < 2) throw new Error(`${mnemonic} requires two operands.`);
      const bits = operandBits(operands[0]);
      const left = readOperand(context, operands[0]);
      const right = readOperand(context, operands[1]);
      const result = mnemonic === 'xor' ? left ^ right : mnemonic === 'and' ? left & right : left | right;
      writeOperand(context, operands[0], setLogicFlags(this.registers, result, bits));
      return;
    }
    if (mnemonic === 'test') {
      if (operands.length < 2) throw new Error('test requires two operands.');
      const bits = operandBits(operands[0]);
      setLogicFlags(this.registers, readOperand(context, operands[0]) & readOperand(context, operands[1]), bits);
      return;
    }
    if (mnemonic === 'add' || mnemonic === 'sub' || mnemonic === 'cmp') {
      if (operands.length < 2) throw new Error(`${mnemonic} requires two operands.`);
      const bits = operandBits(operands[0]);
      const left = readOperand(context, operands[0]);
      const right = readOperand(context, operands[1]);
      const result = mnemonic === 'add' ? left + right : left - right;
      const clipped = mnemonic === 'add'
        ? setAddFlags(this.registers, left, right, result, bits)
        : setSubFlags(this.registers, left, right, result, bits);
      if (mnemonic !== 'cmp') writeOperand(context, operands[0], clipped);
      return;
    }
    if (mnemonic === 'inc' || mnemonic === 'dec') {
      if (!operands[0]) throw new Error(`${mnemonic} requires one operand.`);
      const oldCf = this.registers.getFlag(FLAG_CF);
      const bits = operandBits(operands[0]);
      const value = readOperand(context, operands[0]);
      const delta = mnemonic === 'inc' ? 1n : -1n;
      const result = delta > 0n
        ? setAddFlags(this.registers, value, 1n, value + 1n, bits)
        : setSubFlags(this.registers, value, 1n, value - 1n, bits);
      this.registers.setFlag(FLAG_CF, oldCf);
      writeOperand(context, operands[0], result);
      return;
    }
    if (mnemonic === 'neg' || mnemonic === 'not') {
      if (!operands[0]) throw new Error(`${mnemonic} requires one operand.`);
      const bits = operandBits(operands[0]);
      const value = readOperand(context, operands[0]);
      const result = mnemonic === 'not' ? (~value) & unsignedMask(bits) : setSubFlags(this.registers, 0n, value, -value, bits);
      writeOperand(context, operands[0], result);
      return;
    }
    if (mnemonic === 'shl' || mnemonic === 'sal' || mnemonic === 'shr' || mnemonic === 'sar') {
      if (operands.length < 2) throw new Error(`${mnemonic} requires two operands.`);
      const bits = operandBits(operands[0]);
      const mask = unsignedMask(bits);
      const original = readOperand(context, operands[0]) & mask;
      const rawCount = Number(readOperand(context, operands[1]) & (bits === 64 ? 0x3fn : 0x1fn));
      if (rawCount === 0) return;
      if (rawCount > bits) throw new Error(`${mnemonic} count ${rawCount} exceeds the modeled operand width ${bits}.`);
      let result: bigint;
      let carry: boolean;
      if (mnemonic === 'shl' || mnemonic === 'sal') {
        carry = ((original >> BigInt(bits - rawCount)) & 1n) !== 0n;
        result = (original << BigInt(rawCount)) & mask;
        if (rawCount === 1) this.registers.setFlag(FLAG_OF, ((result >> BigInt(bits - 1)) & 1n) !== (carry ? 1n : 0n));
      } else if (mnemonic === 'shr') {
        carry = ((original >> BigInt(rawCount - 1)) & 1n) !== 0n;
        result = original >> BigInt(rawCount);
        if (rawCount === 1) this.registers.setFlag(FLAG_OF, ((original >> BigInt(bits - 1)) & 1n) !== 0n);
      } else {
        carry = ((original >> BigInt(rawCount - 1)) & 1n) !== 0n;
        result = signedValue(original, bits) >> BigInt(rawCount);
        if (rawCount === 1) this.registers.setFlag(FLAG_OF, false);
      }
      this.registers.setFlag(FLAG_CF, carry);
      writeOperand(context, operands[0], setCommonFlags(this.registers, result, bits));
      return;
    }
    if (mnemonic === 'imul') {
      let bits: number;
      let full: bigint;
      if (operands.length === 2) {
        bits = operandBits(operands[0]);
        full = signedValue(readOperand(context, operands[0]), bits) * signedValue(readOperand(context, operands[1]), operandBits(operands[1], bits));
      } else if (operands.length === 3) {
        bits = operandBits(operands[0]);
        full = signedValue(readOperand(context, operands[1]), operandBits(operands[1], bits)) * signedValue(readOperand(context, operands[2]), operandBits(operands[2], bits));
      } else {
        throw new Error('One-operand imul is not implemented yet.');
      }
      const clipped = full & unsignedMask(bits);
      const overflow = signedValue(clipped, bits) !== full;
      this.registers.setFlag(FLAG_CF, overflow);
      this.registers.setFlag(FLAG_OF, overflow);
      writeOperand(context, operands[0], clipped);
      return;
    }
    if (mnemonic === 'cdqe') {
      this.registers.write('rax', signedValue(this.registers.read('eax'), 32));
      return;
    }
    if (mnemonic === 'cqo') {
      this.registers.write('rdx', signedValue(this.registers.read('rax'), 64) < 0n ? MASK64 : 0n);
      return;
    }

    if (mnemonic === 'call') {
      this.push(nextRip);
      this.registers.write('rip', resolveTransferTarget(context));
      return;
    }
    if (mnemonic === 'ret' || mnemonic === 'retq') {
      this.registers.write('rip', this.pop());
      if (operands[0]?.kind === 'immediate') this.registers.write('rsp', this.registers.read('rsp') + scalar(operands[0].value));
      return;
    }
    if (mnemonic === 'jmp') {
      this.registers.write('rip', resolveTransferTarget(context));
      return;
    }
    if (instruction.controlFlow === 'jump') {
      const taken = branchTaken(this.registers, mnemonic);
      if (taken === null) throw new Error(`Conditional transfer ${mnemonic} is not implemented.`);
      if (taken) this.registers.write('rip', resolveTransferTarget(context));
      return;
    }
    if (mnemonic === 'syscall') {
      this.registers.write('rcx', nextRip);
      this.registers.write('r11', this.registers.read('rflags'));
      this.syscall();
      return;
    }

    throw new Error(`Instruction ${mnemonic}${instruction.operands ? ` ${instruction.operands}` : ''} is not implemented by the x86-64 browser provider.`);
  }

  step(): ExecutionSnapshot {
    if (this.statusValue === 'exited' || this.statusValue === 'halted' || this.statusValue === 'trapped') return this.snapshot();
    if (this.instructionCountValue >= this.policy.maxInstructions) {
      this.trap(`Instruction budget exhausted at ${this.policy.maxInstructions} instructions.`);
      return this.snapshot();
    }

    try {
      const rip = this.registers.read('rip');
      const address = numberAddress(rip, 'RIP');
      const bytes = this.memory.readExecutableWindow(rip, 15);
      const instruction = this.decoder.decodeOne(bytes, address);
      if (!instruction) throw new Error(`Capstone could not decode an instruction at 0x${address.toString(16)}.`);
      this.lastInstructionValue = instruction;
      this.instructionCountValue += 1;
      appendEvent(this.eventsValue, { kind: 'instruction', address, mnemonic: instruction.mnemonic, operands: instruction.operands });
      this.execute(instruction);
      const postStatus = this.statusValue as ExecutionStatus;
      if (postStatus !== 'exited' && postStatus !== 'halted' && postStatus !== 'trapped' && postStatus !== 'running') this.statusValue = 'paused';
    } catch (error: unknown) {
      this.trap(error instanceof Error ? error.message : String(error));
    }
    return this.snapshot();
  }
}
