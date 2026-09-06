import type { BinaryAnalysisSummary } from '../../binary/model';
import { buildFunctionCfg, type FunctionCfg } from '../cfg';
import type { AnalysisGraph } from '../model';
import type { DataflowInstruction, DataflowInstructionInfo, DataflowResult, DataflowValue, DataflowValueKind } from './model';
import {
  LINUX_SYSCALL_ARGUMENT_REGS,
  LINUX_X86_64_SYSCALLS,
  SYSV_ARGUMENT_REGS,
  SYSV_CALLER_SAVED,
  SYSCALL_CLOBBERS,
  directRegister,
  fromCanonical,
  fromSourceNode,
  operandRegisters,
  parseInteger,
  sourceMemoryKey,
  splitOperands,
  unique
} from './x86';

interface FlowState {
  regs: Map<string, string>;
  memory: Map<string, string>;
}

interface FlowBlock {
  id: string;
  instructions: DataflowInstruction[];
  predecessors: string[];
  successors: string[];
}

function blocksFromBinary(summary: BinaryAnalysisSummary, instructions: DataflowInstruction[]): FlowBlock[] {
  const canonicalByAddress = new Map(summary.instructions.map((instruction) => [instruction.address, instruction]));
  const cfg: FunctionCfg = buildFunctionCfg(summary.instructions, summary.rootAddress);
  const normalizedByAddress = new Map(instructions.filter((instruction) => instruction.address !== null).map((instruction) => [instruction.address!, instruction]));
  return cfg.blocks.map((block) => ({
    id: block.id,
    instructions: block.instructions.map((instruction) => normalizedByAddress.get(instruction.address)).filter((value): value is DataflowInstruction => Boolean(value)),
    predecessors: cfg.edges.filter((edge) => edge.to === block.id).map((edge) => edge.from),
    successors: cfg.edges.filter((edge) => edge.from === block.id).map((edge) => edge.to)
  })).filter((block) => block.instructions.length > 0 && block.instructions.every((instruction) => instruction.address === null || canonicalByAddress.has(instruction.address)));
}

function blocksFromSource(instructions: DataflowInstruction[]): FlowBlock[] {
  return [{ id: 'source:linear', instructions, predecessors: [], successors: [] }];
}

function stateSignature(state: FlowState): string {
  const regs = [...state.regs.entries()].sort(([left], [right]) => left.localeCompare(right));
  const memory = [...state.memory.entries()].sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([regs, memory]);
}

function analyzeNormalizedDataflow(
  fileId: string,
  sourceKind: DataflowResult['sourceKind'],
  instructions: DataflowInstruction[],
  blocks: FlowBlock[],
  functionName: string | null,
  functionAddress: number | null
): DataflowResult {
  const valuesById = new Map<string, DataflowValue>();
  const blockExit = new Map<string, FlowState>();
  const blockEntry = new Map<string, FlowState>();
  const instructionInfo = new Map<string, DataflowInstructionInfo>();

  const value = (id: string, seed: Omit<DataflowValue, 'id' | 'uses'>): DataflowValue => {
    const existing = valuesById.get(id);
    if (existing) {
      existing.kind = seed.kind;
      existing.label = seed.label;
      existing.register = seed.register;
      existing.memoryKey = seed.memoryKey;
      existing.constant = seed.constant;
      existing.definitionInstructionId = seed.definitionInstructionId;
      existing.inputs = seed.inputs;
      existing.confidence = seed.confidence;
      existing.evidence = seed.evidence;
      return existing;
    }
    const created: DataflowValue = { id, uses: [], ...seed };
    valuesById.set(id, created);
    return created;
  };

  const entryRegister = (register: string) => value(`entry:reg:${register}`, {
    kind: 'entry', label: `${register.toUpperCase()} entry`, register, memoryKey: null, constant: null,
    definitionInstructionId: null, inputs: [], confidence: 'conservative', evidence: 'Function-entry register state.'
  });
  const entryMemory = (key: string) => value(`entry:mem:${key}`, {
    kind: 'memory-entry', label: `${key} entry`, register: null, memoryKey: key, constant: null,
    definitionInstructionId: null, inputs: [], confidence: 'conservative', evidence: 'Function-entry memory state.'
  });

  const ensureReg = (state: FlowState, register: string): string => {
    const current = state.regs.get(register);
    if (current) return current;
    const entry = entryRegister(register).id;
    state.regs.set(register, entry);
    return entry;
  };
  const ensureMemory = (state: FlowState, key: string): string => {
    const current = state.memory.get(key);
    if (current) return current;
    const entry = entryMemory(key).id;
    state.memory.set(key, entry);
    return entry;
  };

  const mergeBlockEntry = (block: FlowBlock): FlowState => {
    const predecessors = block.predecessors.map((id) => blockExit.get(id)).filter((item): item is FlowState => Boolean(item));
    if (predecessors.length === 0) return { regs: new Map(), memory: new Map() };
    if (predecessors.length === 1) return { regs: new Map(predecessors[0].regs), memory: new Map(predecessors[0].memory) };
    const regs = new Map<string, string>();
    const memory = new Map<string, string>();
    const regKeys = unique(predecessors.flatMap((state) => [...state.regs.keys()]));
    for (const register of regKeys) {
      const inputs = unique(predecessors.map((state) => state.regs.get(register) ?? entryRegister(register).id));
      if (inputs.length === 1) regs.set(register, inputs[0]);
      else {
        const phi = value(`phi:${block.id}:reg:${register}`, {
          kind: 'phi', label: `${register.toUpperCase()} φ`, register, memoryKey: null, constant: null,
          definitionInstructionId: null, inputs, confidence: 'conservative', evidence: `Register merge at ${block.id}.`
        });
        regs.set(register, phi.id);
      }
    }
    const memoryKeys = unique(predecessors.flatMap((state) => [...state.memory.keys()]));
    for (const key of memoryKeys) {
      const inputs = unique(predecessors.map((state) => state.memory.get(key) ?? entryMemory(key).id));
      if (inputs.length === 1) memory.set(key, inputs[0]);
      else {
        const phi = value(`phi:${block.id}:mem:${key}`, {
          kind: 'phi', label: `${key} φ`, register: null, memoryKey: key, constant: null,
          definitionInstructionId: null, inputs, confidence: 'conservative', evidence: `Memory merge at ${block.id}.`
        });
        memory.set(key, phi.id);
      }
    }
    return { regs, memory };
  };

  const sourceValue = (state: FlowState, instruction: DataflowInstruction, operand: string, role: string): string => {
    const immediate = parseInteger(operand);
    if (immediate !== null) return value(`const:${instruction.id}:${role}:${immediate}`, {
      kind: 'constant', label: immediate, register: null, memoryKey: null, constant: immediate,
      definitionInstructionId: null, inputs: [], confidence: 'exact', evidence: 'Immediate operand.'
    }).id;
    const register = directRegister(operand);
    if (register) return ensureReg(state, register);
    const memoryKey = sourceMemoryKey(operand);
    if (memoryKey) return ensureMemory(state, memoryKey);
    return value(`unknown:${instruction.id}:${role}`, {
      kind: 'unknown', label: operand || 'unknown', register: null, memoryKey: null, constant: null,
      definitionInstructionId: null, inputs: [], confidence: 'conservative', evidence: 'Operand is not statically modeled yet.'
    }).id;
  };

  const processInstruction = (state: FlowState, instruction: DataflowInstruction) => {
    const mnemonic = instruction.mnemonic.toLowerCase();
    const operands = splitOperands(instruction.operands);
    const att = instruction.operands.includes('%') || instruction.operands.includes('$');
    const ordered = att && operands.length >= 2 ? [...operands].reverse() : operands;
    const destination = ordered[0] ?? '';
    const source = ordered[1] ?? '';

    if (/^(?:mov|mov[a-z]*|movzx|movsx|movsxd)$/i.test(mnemonic)) {
      const destinationRegister = directRegister(destination);
      const destinationMemory = sourceMemoryKey(destination) ?? instruction.memoryWrites[0] ?? null;
      const sourceMemory = sourceMemoryKey(source) ?? instruction.memoryReads[0] ?? null;
      let inputId: string;
      if (sourceMemory) inputId = ensureMemory(state, sourceMemory);
      else inputId = sourceValue(state, instruction, source, 'src');
      if (destinationRegister) {
        const sourceEntry = valuesById.get(inputId);
        const kind: DataflowValueKind = sourceEntry?.kind === 'constant' ? 'constant' : sourceMemory ? 'memory-load' : 'copy';
        const defined = value(`def:${instruction.id}:reg:${destinationRegister}`, {
          kind,
          label: `${destinationRegister.toUpperCase()} ← ${source || sourceMemory || '?'}`,
          register: destinationRegister,
          memoryKey: sourceMemory,
          constant: sourceEntry?.constant ?? null,
          definitionInstructionId: instruction.id,
          inputs: [inputId],
          confidence: 'exact',
          evidence: sourceKind === 'raw-elf-capstone' ? 'Capstone operand/register detail.' : 'x86 source transfer model.'
        });
        state.regs.set(destinationRegister, defined.id);
      } else if (destinationMemory) {
        const defined = value(`def:${instruction.id}:mem:${destinationMemory}`, {
          kind: 'memory-store', label: `${destinationMemory} ← ${source || '?'}`, register: null, memoryKey: destinationMemory,
          constant: valuesById.get(inputId)?.constant ?? null, definitionInstructionId: instruction.id, inputs: [inputId], confidence: 'exact',
          evidence: sourceKind === 'raw-elf-capstone' ? 'Capstone memory write detail.' : 'x86 source memory-store model.'
        });
        state.memory.set(destinationMemory, defined.id);
      }
      return;
    }

    if (/^lea/.test(mnemonic)) {
      const destinationRegister = directRegister(destination);
      if (destinationRegister) {
        const inputs = operandRegisters(source).map((register) => ensureReg(state, register));
        const defined = value(`def:${instruction.id}:reg:${destinationRegister}`, {
          kind: 'address', label: `${destinationRegister.toUpperCase()} ← &${source}`, register: destinationRegister,
          memoryKey: sourceMemoryKey(source), constant: null, definitionInstructionId: instruction.id, inputs, confidence: 'exact', evidence: 'x86 LEA effective-address semantics.'
        });
        state.regs.set(destinationRegister, defined.id);
      }
      return;
    }

    if (/^(?:xor|sub)$/i.test(mnemonic) && destination && source && directRegister(destination) && directRegister(destination) === directRegister(source)) {
      const register = directRegister(destination)!;
      const defined = value(`def:${instruction.id}:reg:${register}`, {
        kind: 'constant', label: `${register.toUpperCase()} = 0`, register, memoryKey: null, constant: '0',
        definitionInstructionId: instruction.id, inputs: [], confidence: 'exact', evidence: `${mnemonic} self-zeroing idiom.`
      });
      state.regs.set(register, defined.id);
      return;
    }

    if (/^(?:add|sub|adc|sbb|and|or|xor|imul|shl|shr|sar|sal|rol|ror)/.test(mnemonic)) {
      const register = directRegister(destination);
      if (register) {
        const left = ensureReg(state, register);
        const right = sourceValue(state, instruction, source, 'rhs');
        const defined = value(`def:${instruction.id}:reg:${register}`, {
          kind: 'expression', label: `${register.toUpperCase()} ← ${mnemonic}`, register, memoryKey: null, constant: null,
          definitionInstructionId: instruction.id, inputs: [left, right], confidence: 'exact', evidence: 'Conservative arithmetic dataflow.'
        });
        state.regs.set(register, defined.id);
      }
      return;
    }

    if (/^push/.test(mnemonic)) {
      const sourceId = sourceValue(state, instruction, operands[0] ?? '', 'push');
      const memoryKey = instruction.memoryWrites[0] ?? 'stack:rsp';
      const stored = value(`def:${instruction.id}:mem:${memoryKey}`, {
        kind: 'memory-store', label: `${memoryKey} ← push`, register: null, memoryKey, constant: valuesById.get(sourceId)?.constant ?? null,
        definitionInstructionId: instruction.id, inputs: [sourceId], confidence: 'conservative', evidence: 'x86 push stack effect.'
      });
      state.memory.set(memoryKey, stored.id);
    }

    if (/^pop/.test(mnemonic)) {
      const memoryKey = instruction.memoryReads[0] ?? 'stack:rsp';
      const loaded = ensureMemory(state, memoryKey);
      const register = directRegister(operands[0] ?? '');
      if (register) {
        const defined = value(`def:${instruction.id}:reg:${register}`, {
          kind: 'memory-load', label: `${register.toUpperCase()} ← pop`, register, memoryKey, constant: valuesById.get(loaded)?.constant ?? null,
          definitionInstructionId: instruction.id, inputs: [loaded], confidence: 'conservative', evidence: 'x86 pop stack effect.'
        });
        state.regs.set(register, defined.id);
      }
    }

    if (instruction.controlFlow === 'call') {
      for (const register of SYSV_CALLER_SAVED) {
        const kind: DataflowValueKind = register === 'rax' ? 'call-result' : 'clobber';
        const defined = value(`def:${instruction.id}:reg:${register}`, {
          kind, label: register === 'rax' ? 'RAX ← call result' : `${register.toUpperCase()} call-clobbered`, register,
          memoryKey: null, constant: null, definitionInstructionId: instruction.id, inputs: [], confidence: 'exact', evidence: 'System V AMD64 call ABI.'
        });
        state.regs.set(register, defined.id);
      }
      return;
    }

    if (instruction.controlFlow === 'syscall') {
      const result = value(`def:${instruction.id}:reg:rax`, {
        kind: 'call-result', label: 'RAX ← syscall result', register: 'rax', memoryKey: null, constant: null,
        definitionInstructionId: instruction.id, inputs: [], confidence: 'exact', evidence: 'Linux x86-64 syscall ABI.'
      });
      state.regs.set('rax', result.id);
      for (const register of SYSCALL_CLOBBERS) {
        const clobber = value(`def:${instruction.id}:reg:${register}`, {
          kind: 'clobber', label: `${register.toUpperCase()} syscall-clobbered`, register, memoryKey: null, constant: null,
          definitionInstructionId: instruction.id, inputs: [], confidence: 'exact', evidence: 'Linux x86-64 syscall ABI.'
        });
        state.regs.set(register, clobber.id);
      }
      return;
    }

    for (const key of instruction.memoryWrites) {
      const clobber = value(`def:${instruction.id}:mem:${key}`, {
        kind: 'clobber', label: `${key} modified`, register: null, memoryKey: key, constant: null,
        definitionInstructionId: instruction.id, inputs: [], confidence: 'conservative', evidence: 'Memory write without modeled transfer semantics.'
      });
      state.memory.set(key, clobber.id);
    }
    for (const register of instruction.registerWrites) {
      if (register === 'rip') continue;
      const clobber = value(`def:${instruction.id}:reg:${register}`, {
        kind: 'clobber', label: `${register.toUpperCase()} ← ${mnemonic}`, register, memoryKey: null, constant: null,
        definitionInstructionId: instruction.id, inputs: [], confidence: 'conservative', evidence: 'Register write proven; transfer semantics not yet modeled.'
      });
      state.regs.set(register, clobber.id);
    }
  };

  let converged = false;
  let iterations = 0;
  const budget = Math.max(4, Math.min(32, blocks.length * 4));
  for (; iterations < budget; iterations += 1) {
    let changed = false;
    for (const block of blocks) {
      const entry = mergeBlockEntry(block);
      blockEntry.set(block.id, entry);
      const state: FlowState = { regs: new Map(entry.regs), memory: new Map(entry.memory) };
      for (const instruction of block.instructions) processInstruction(state, instruction);
      const previous = blockExit.get(block.id);
      if (!previous || stateSignature(previous) !== stateSignature(state)) {
        blockExit.set(block.id, state);
        changed = true;
      }
    }
    if (!changed) {
      converged = true;
      iterations += 1;
      break;
    }
  }

  for (const valueEntry of valuesById.values()) valueEntry.uses = [];

  const addUse = (valueId: string, instructionId: string, role: string) => {
    const valueEntry = valuesById.get(valueId);
    if (!valueEntry) return;
    if (!valueEntry.uses.some((use) => use.instructionId === instructionId && use.role === role)) valueEntry.uses.push({ instructionId, role });
  };

  for (const block of blocks) {
    const state = { regs: new Map(blockEntry.get(block.id)?.regs ?? []), memory: new Map(blockEntry.get(block.id)?.memory ?? []) };
    for (const instruction of block.instructions) {
      const info: DataflowInstructionInfo = { instruction, uses: [], defs: [], callArguments: [], returnValueId: null, syscallNumber: null, syscallName: null, notes: [] };
      let effectiveRegisterReads = instruction.registerReads;
      if (instruction.controlFlow === 'syscall') {
        const numberValueId = ensureReg(state, 'rax');
        const constant = valuesById.get(numberValueId)?.constant ?? null;
        const parsed = constant !== null ? Number.parseInt(constant, 0) : Number.NaN;
        const spec = Number.isFinite(parsed) ? LINUX_X86_64_SYSCALLS.get(parsed) ?? null : null;
        info.syscallNumber = Number.isFinite(parsed) ? parsed : null;
        info.syscallName = spec?.name ?? null;
        effectiveRegisterReads = ['rax', ...LINUX_SYSCALL_ARGUMENT_REGS.slice(0, spec?.args ?? LINUX_SYSCALL_ARGUMENT_REGS.length)];
        if (spec) info.notes.push(`Linux x86-64 syscall #${parsed}: ${spec.name}.`);
      }
      for (const register of effectiveRegisterReads) {
        if (register === 'rip') continue;
        const valueId = ensureReg(state, register);
        const role = instruction.controlFlow === 'syscall' ? (register === 'rax' ? 'syscall number' : `arg ${register}`) : register;
        info.uses.push({ valueId, role });
        addUse(valueId, instruction.id, instruction.controlFlow === 'syscall' ? (register === 'rax' ? 'syscall number' : `syscall arg ${register}`) : register);
      }
      for (const key of instruction.memoryReads) {
        const valueId = ensureMemory(state, key);
        info.uses.push({ valueId, role: key });
        addUse(valueId, instruction.id, key);
      }
      if (instruction.controlFlow === 'call') {
        for (const register of SYSV_ARGUMENT_REGS) {
          const valueId = ensureReg(state, register);
          info.callArguments.push({ register, valueId });
          if (!info.uses.some((use) => use.valueId === valueId && use.role === register)) {
            info.uses.push({ valueId, role: `arg ${register}` });
            addUse(valueId, instruction.id, `call arg ${register}`);
          }
        }
      }
      if (instruction.controlFlow === 'syscall') {
        const spec = info.syscallNumber !== null ? LINUX_X86_64_SYSCALLS.get(info.syscallNumber) ?? null : null;
        const registers = ['rax', ...LINUX_SYSCALL_ARGUMENT_REGS.slice(0, spec?.args ?? LINUX_SYSCALL_ARGUMENT_REGS.length)];
        for (const register of registers) info.callArguments.push({ register, valueId: ensureReg(state, register) });
      }
      processInstruction(state, instruction);
      for (const register of instruction.registerWrites) {
        if (register === 'rip') continue;
        const valueId = state.regs.get(register);
        if (valueId) info.defs.push({ valueId, role: register });
      }
      for (const key of instruction.memoryWrites) {
        const valueId = state.memory.get(key);
        if (valueId) info.defs.push({ valueId, role: key });
      }
      if (instruction.controlFlow === 'call' || instruction.controlFlow === 'syscall') {
        info.returnValueId = state.regs.get('rax') ?? null;
      }
      instructionInfo.set(instruction.id, info);
    }
  }

  const values = [...valuesById.values()];
  const phiValues = values.filter((entry) => entry.kind === 'phi');
  return {
    sourceKind,
    fileId,
    functionName,
    functionAddress,
    instructions,
    values,
    instructionInfo,
    phiValues,
    fixedPointConverged: converged,
    fixedPointIterations: iterations,
    diagnostics: [
      `Dataflow: ${instructions.length} instruction(s), ${values.length} value(s), ${phiValues.length} phi value(s).`,
      `State fixed point: ${converged ? 'converged' : 'partial'} after ${iterations} iteration(s).`
    ]
  };
}

export function analyzeDataflow(graph: AnalysisGraph, binarySummary: BinaryAnalysisSummary | null): DataflowResult | null {
  if (binarySummary && graph.sourceKind === 'raw-elf-capstone') {
    const instructions = binarySummary.instructions.map(fromCanonical);
    return analyzeNormalizedDataflow(
      graph.fileId,
      'raw-elf-capstone',
      instructions,
      blocksFromBinary(binarySummary, instructions),
      binarySummary.rootName,
      binarySummary.rootAddress
    );
  }
  if (graph.sourceKind === 'asm-source') {
    const instructions = graph.nodes.map(fromSourceNode).filter((item): item is DataflowInstruction => Boolean(item));
    if (!instructions.length) return null;
    return analyzeNormalizedDataflow(graph.fileId, 'asm-source', instructions, blocksFromSource(instructions), null, null);
  }
  return null;
}
