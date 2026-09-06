import type { CanonicalInstruction } from '../binary/model';

export interface FunctionCfgBlock {
  id: string;
  index: number;
  startAddress: number;
  endAddress: number;
  instructions: CanonicalInstruction[];
  reachable: boolean;
  callTargets: number[];
}

export interface FunctionCfgEdge {
  id: string;
  from: string;
  to: string;
  kind: 'fallthrough' | 'branch';
  label: string;
}

export interface FunctionCfg {
  entryBlockId: string;
  blocks: FunctionCfgBlock[];
  edges: FunctionCfgEdge[];
  reachableBlockIds: Set<string>;
  backEdges: FunctionCfgEdge[];
}

function isUnconditionalJump(instruction: CanonicalInstruction): boolean {
  return instruction.controlFlow === 'jump' && /^(?:jmp|jmpq|ljmp)$/i.test(instruction.mnemonic);
}

function isConditionalJump(instruction: CanonicalInstruction): boolean {
  return instruction.controlFlow === 'jump' && !isUnconditionalJump(instruction);
}

export function buildFunctionCfg(instructions: CanonicalInstruction[], functionAddress: number): FunctionCfg {
  if (!instructions.length) throw new Error('Cannot build CFG from an empty instruction sequence.');
  const sorted = [...instructions].sort((left, right) => left.address - right.address);
  const instructionByAddress = new Map(sorted.map((instruction) => [instruction.address, instruction]));
  const starts = new Set<number>([sorted[0].address]);

  for (let index = 0; index < sorted.length; index += 1) {
    const instruction = sorted[index];
    const next = sorted[index + 1];
    if (instruction.directTarget !== null && instructionByAddress.has(instruction.directTarget)) starts.add(instruction.directTarget);
    if (next && (instruction.controlFlow === 'jump' || instruction.controlFlow === 'return')) starts.add(next.address);
  }

  const orderedStarts = [...starts].sort((left, right) => left - right);
  const blocks: FunctionCfgBlock[] = [];
  const blockByInstruction = new Map<number, string>();
  for (let index = 0; index < orderedStarts.length; index += 1) {
    const startAddress = orderedStarts[index];
    const nextStart = orderedStarts[index + 1] ?? Number.POSITIVE_INFINITY;
    const blockInstructions = sorted.filter((instruction) => instruction.address >= startAddress && instruction.address < nextStart);
    if (!blockInstructions.length) continue;
    const endAddress = blockInstructions.at(-1)!.endAddress;
    const id = `bb:${startAddress.toString(16)}`;
    const callTargets = blockInstructions
      .filter((instruction) => instruction.controlFlow === 'call' && instruction.directTarget !== null)
      .map((instruction) => instruction.directTarget!);
    const block: FunctionCfgBlock = { id, index: blocks.length, startAddress, endAddress, instructions: blockInstructions, reachable: false, callTargets };
    blocks.push(block);
    for (const instruction of blockInstructions) blockByInstruction.set(instruction.address, id);
  }

  const edges: FunctionCfgEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string, kind: FunctionCfgEdge['kind'], label: string) => {
    const key = `${from}:${to}:${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: key, from, to, kind, label });
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const last = block.instructions.at(-1)!;
    const nextBlock = blocks[index + 1] ?? null;
    if (last.controlFlow === 'jump' && last.directTarget !== null) {
      const target = blockByInstruction.get(last.directTarget);
      if (target) addEdge(block.id, target, 'branch', isConditionalJump(last) ? last.mnemonic : 'jump');
      if (isConditionalJump(last) && nextBlock) addEdge(block.id, nextBlock.id, 'fallthrough', 'fallthrough');
      continue;
    }
    if (last.controlFlow === 'return') continue;
    if (nextBlock) addEdge(block.id, nextBlock.id, 'fallthrough', 'fallthrough');
  }

  const entry = blocks.find((block) => functionAddress >= block.startAddress && functionAddress < block.endAddress) ?? blocks[0];
  const reachable = new Set<string>();
  const queue = [entry.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of edges) if (edge.from === id && !reachable.has(edge.to)) queue.push(edge.to);
  }
  for (const block of blocks) block.reachable = reachable.has(block.id);

  const startById = new Map(blocks.map((block) => [block.id, block.startAddress]));
  const backEdges = edges.filter((edge) => (startById.get(edge.to) ?? Number.POSITIVE_INFINITY) <= (startById.get(edge.from) ?? Number.NEGATIVE_INFINITY));
  return { entryBlockId: entry.id, blocks, edges, reachableBlockIds: reachable, backEdges };
}
