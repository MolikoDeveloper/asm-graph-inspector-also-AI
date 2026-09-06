import type { AnalysisGraph, GraphEdge, GraphNode } from '../model';
import type { DataflowInstruction, DataflowProjection, DataflowResult } from './model';
import { unique } from './x86';

function nodeForInstruction(result: DataflowResult, instruction: DataflowInstruction, index: number, projection: DataflowProjection): GraphNode {
  const info = result.instructionInfo.get(instruction.id);
  const role = instruction.controlFlow === 'syscall' ? 'syscall' : instruction.controlFlow === 'call' ? 'call' : instruction.controlFlow === 'jump' ? 'branch' : 'instruction';
  const detailParts = [instruction.address !== null ? `0x${instruction.address.toString(16)}` : `line ${instruction.line}`];
  if (projection === 'registers') detailParts.push(unique([...instruction.registerReads, ...instruction.registerWrites]).join(', ') || 'no tracked registers');
  if (projection === 'memory') detailParts.push(unique([...instruction.memoryReads, ...instruction.memoryWrites]).join(', ') || 'no tracked memory');
  if (projection === 'calls') detailParts.push(`${info?.callArguments.length ?? 0} ABI input(s)`);
  const syscallTitle = instruction.controlFlow === 'syscall' && info?.syscallNumber !== null && info?.syscallNumber !== undefined
    ? `syscall #${info.syscallNumber}${info.syscallName ? ` · ${info.syscallName}` : ''}`
    : null;
  return {
    id: `df:inst:${instruction.id}`,
    line: instruction.line,
    address: instruction.address ?? undefined,
    title: syscallTitle ?? `${instruction.mnemonic}${instruction.operands ? ` ${instruction.operands}` : ''}`,
    detail: detailParts.join(' · '),
    kind: role,
    evidence: result.sourceKind === 'raw-elf-capstone' ? 'Canonical Capstone instruction + x86-64 static dataflow.' : 'ASM source + conservative x86-64 static dataflow.',
    registerReads: instruction.registerReads,
    registerWrites: instruction.registerWrites,
    dataflowUses: info?.uses.map((entry) => entry.role) ?? [],
    dataflowDefs: info?.defs.map((entry) => entry.role) ?? [],
    dataflowValueCount: (info?.uses.length ?? 0) + (info?.defs.length ?? 0),
    x: 210,
    y: 62 + index * 84,
    reachable: true
  };
}

function addEntryNodes(result: DataflowResult, nodes: GraphNode[], edges: GraphEdge[], instructionNodeById: Map<string, string>, allowedValueIds: Set<string>) {
  const entries = result.values.filter((value) => (value.kind === 'entry' || value.kind === 'memory-entry') && value.uses.some((use) => allowedValueIds.has(value.id) && instructionNodeById.has(use.instructionId)));
  let index = 0;
  for (const value of entries) {
    const id = `df:value:${value.id}`;
    nodes.push({
      id,
      line: 0,
      title: value.label,
      detail: value.kind === 'entry' ? 'function entry' : 'memory entry',
      kind: 'data',
      evidence: value.evidence,
      dataflowValueKind: value.kind,
      dataflowUses: value.uses.map((use) => use.role),
      x: 18,
      y: 62 + index * 62,
      reachable: true
    });
    index += 1;
    for (const use of value.uses) {
      const target = instructionNodeById.get(use.instructionId);
      if (target) edges.push({ id: `df:edge:${value.id}:${use.instructionId}:${use.role}`, from: id, to: target, kind: 'data', label: use.role });
    }
  }
}

function projectFlow(result: DataflowResult, projection: Exclude<DataflowProjection, 'raw'>): AnalysisGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  let filteredInstructions = result.instructions.filter((instruction) => {
    if (projection === 'calls') return instruction.controlFlow === 'call' || instruction.controlFlow === 'syscall';
    if (projection === 'memory') return instruction.memoryReads.length > 0 || instruction.memoryWrites.length > 0;
    return true;
  });
  if (projection === 'calls') {
    const selected = new Set(filteredInstructions.map((instruction) => instruction.id));
    const visitValue = (valueId: string, depth: number) => {
      if (depth > 8) return;
      const value = result.values.find((candidate) => candidate.id === valueId);
      if (!value) return;
      if (value.definitionInstructionId) selected.add(value.definitionInstructionId);
      for (const input of value.inputs) visitValue(input, depth + 1);
    };
    for (const instruction of filteredInstructions) {
      const info = result.instructionInfo.get(instruction.id);
      for (const use of info?.uses ?? []) visitValue(use.valueId, 0);
    }
    filteredInstructions = result.instructions.filter((instruction) => selected.has(instruction.id));
  }
  const instructionNodeById = new Map<string, string>();
  filteredInstructions.forEach((instruction, index) => {
    const node = nodeForInstruction(result, instruction, index, projection);
    instructionNodeById.set(instruction.id, node.id);
    nodes.push(node);
  });
  const allowedValues = new Set<string>();
  for (const value of result.values) {
    const relevant = value.uses.some((use) => instructionNodeById.has(use.instructionId)) || (value.definitionInstructionId ? instructionNodeById.has(value.definitionInstructionId) : false);
    if (relevant) allowedValues.add(value.id);
  }
  addEntryNodes(result, nodes, edges, instructionNodeById, allowedValues);

  for (const value of result.values) {
    if (!allowedValues.has(value.id) || !value.definitionInstructionId) continue;
    const from = instructionNodeById.get(value.definitionInstructionId);
    if (!from) continue;
    for (const use of value.uses) {
      const to = instructionNodeById.get(use.instructionId);
      if (!to || to === from) continue;
      if (projection === 'registers' && !value.register) continue;
      if (projection === 'memory' && !value.memoryKey) continue;
      edges.push({
        id: `df:edge:${value.id}:${use.instructionId}:${use.role}`,
        from,
        to,
        kind: 'data',
        label: value.register?.toUpperCase() ?? value.memoryKey ?? use.role
      });
    }
  }

  if (projection === 'registers') {
    const registers = unique(filteredInstructions.flatMap((instruction) => [...instruction.registerReads, ...instruction.registerWrites]));
    const order = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rsp', 'rbp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
    registers.sort((left, right) => {
      const a = order.indexOf(left); const b = order.indexOf(right);
      return (a < 0 ? 999 : a) - (b < 0 ? 999 : b) || left.localeCompare(right);
    });
    registers.forEach((register, index) => nodes.push({ id: `df:lane:reg:${register}`, line: 0, title: register.toUpperCase(), detail: 'register lane', kind: 'label', evidence: 'Projection lane.', x: index * 188, y: 10, reachable: true, dataflowLane: register }));
    for (const node of nodes) {
      if (!node.id.startsWith('df:inst:')) continue;
      const source = filteredInstructions.find((instruction) => `df:inst:${instruction.id}` === node.id);
      const regs = source ? unique([...source.registerReads, ...source.registerWrites]) : [];
      const indices = regs.map((register) => registers.indexOf(register)).filter((index) => index >= 0);
      if (indices.length) node.x = indices.reduce((sum, index) => sum + index * 188, 0) / indices.length;
    }
  }

  if (projection === 'memory') {
    const keys = unique(filteredInstructions.flatMap((instruction) => [...instruction.memoryReads, ...instruction.memoryWrites])).slice(0, 12);
    keys.forEach((key, index) => nodes.push({ id: `df:lane:mem:${index}`, line: 0, title: key, detail: 'memory lane', kind: 'label', evidence: 'Projection lane.', x: index * 220, y: 10, reachable: true, dataflowLane: key }));
    for (const node of nodes) {
      if (!node.id.startsWith('df:inst:')) continue;
      const source = filteredInstructions.find((instruction) => `df:inst:${instruction.id}` === node.id);
      const matches = source ? unique([...source.memoryReads, ...source.memoryWrites]).map((key) => keys.indexOf(key)).filter((index) => index >= 0) : [];
      if (matches.length) node.x = matches.reduce((sum, index) => sum + index * 220, 0) / matches.length;
    }
  }

  return {
    fileId: result.fileId,
    nodes,
    edges,
    labels,
    diagnostics: result.diagnostics,
    sourceKind: result.sourceKind,
    viewKind: 'dataflow',
    functionAddress: result.functionAddress ?? undefined,
    functionName: result.functionName ?? undefined,
    dataflowProjection: projection
  };
}

function projectRaw(result: DataflowResult): AnalysisGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const instructionNodeById = new Map<string, string>();
  result.instructions.forEach((instruction, index) => {
    const node = nodeForInstruction(result, instruction, index, 'raw');
    node.x = 360;
    node.y = 50 + index * 88;
    instructionNodeById.set(instruction.id, node.id);
    nodes.push(node);
  });
  let valueIndex = 0;
  for (const value of result.values) {
    if (value.kind === 'clobber' && value.uses.length === 0) continue;
    const id = `df:value:${value.id}`;
    const side = value.definitionInstructionId ? 1 : -1;
    nodes.push({
      id,
      line: 0,
      title: value.label,
      detail: `${value.kind} · ${value.uses.length} use${value.uses.length === 1 ? '' : 's'}`,
      kind: 'data',
      evidence: value.evidence,
      dataflowValueKind: value.kind,
      dataflowUses: value.uses.map((use) => use.role),
      dataflowValueCount: value.uses.length,
      x: side > 0 ? 720 : 20,
      y: 42 + valueIndex * 58,
      reachable: true
    });
    valueIndex += 1;
    if (value.definitionInstructionId) {
      const from = instructionNodeById.get(value.definitionInstructionId);
      if (from) edges.push({ id: `df:def:${value.id}`, from, to: id, kind: 'data', label: value.register ?? value.memoryKey ?? 'def' });
    }
    for (const input of value.inputs) {
      if (!result.values.some((candidate) => candidate.id === input)) continue;
      edges.push({ id: `df:input:${input}:${value.id}`, from: `df:value:${input}`, to: id, kind: 'data', label: 'input' });
    }
    for (const use of value.uses) {
      const target = instructionNodeById.get(use.instructionId);
      if (target) edges.push({ id: `df:use:${value.id}:${use.instructionId}:${use.role}`, from: id, to: target, kind: 'data', label: use.role });
    }
  }
  return {
    fileId: result.fileId,
    nodes,
    edges,
    labels,
    diagnostics: result.diagnostics,
    sourceKind: result.sourceKind,
    viewKind: 'dataflow',
    functionAddress: result.functionAddress ?? undefined,
    functionName: result.functionName ?? undefined,
    dataflowProjection: 'raw'
  };
}

export function projectDataflow(result: DataflowResult, projection: DataflowProjection): AnalysisGraph {
  return projection === 'raw' ? projectRaw(result) : projectFlow(result, projection);
}
