import type { AnalysisGraph, GraphEdge, GraphNode, GraphNodeKind } from './model';
import { classifyTextContent } from '../project/textClassification';

const SECTION_RE = /^\s*Disassembly of section\s+([^:]+):\s*$/i;
const SYMBOL_RE = /^\s*([0-9a-f]{4,16})\s+<([^>]+)>:\s*$/i;
const INSTRUCTION_RE = /^\s*([0-9a-f]{4,16}):\s*((?:(?:[0-9a-f]{2})\s+){1,15})(.*?)\s*$/i;
const DIRECT_ADDRESS_RE = /(?:^|[\s,])(?:0x)?([0-9a-f]{4,16})(?:\s+<[^>]+>)?\s*$/i;

export interface DisassemblyDumpInstruction {
  line: number;
  address: number;
  bytes: number[];
  mnemonic: string;
  operands: string;
  section: string | null;
}

export interface DisassemblyDumpDocument {
  instructions: DisassemblyDumpInstruction[];
  symbols: Array<{ line: number; address: number; name: string }>;
  sections: string[];
  diagnostics: string[];
}

function instructionKind(mnemonic: string): GraphNodeKind {
  const op = mnemonic.toLowerCase();
  if (op === 'syscall' || op === 'sysenter' || op === 'int') return 'syscall';
  if (op === 'call' || op === 'callq') return 'call';
  if (op === 'jmp' || op.startsWith('j') || op.startsWith('loop')) return 'branch';
  return 'instruction';
}

function splitAssembly(text: string): { mnemonic: string; operands: string } {
  const trimmed = text.trim();
  if (!trimmed) return { mnemonic: '', operands: '' };
  const match = trimmed.match(/^([^\s]+)(?:\s+(.*))?$/);
  return { mnemonic: match?.[1] ?? trimmed, operands: match?.[2]?.trim() ?? '' };
}

function parseAddress(text: string): number | null {
  const value = Number.parseInt(text, 16);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseDisassemblyDump(source: string): DisassemblyDumpDocument {
  const classification = classifyTextContent(source);
  if (classification.kind !== 'disassembly-dump') {
    throw new Error('Text does not contain enough structural disassembly evidence to be imported as an objdump/disassembly dump.');
  }

  const instructions: DisassemblyDumpInstruction[] = [];
  const symbols: DisassemblyDumpDocument['symbols'] = [];
  const sections: string[] = [];
  const diagnostics: string[] = [];
  let currentSection: string | null = null;
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    const section = raw.match(SECTION_RE);
    if (section) {
      currentSection = section[1].trim();
      if (!sections.includes(currentSection)) sections.push(currentSection);
      continue;
    }
    const symbol = raw.match(SYMBOL_RE);
    if (symbol) {
      const address = parseAddress(symbol[1]);
      if (address !== null) symbols.push({ line, address, name: symbol[2] });
      continue;
    }
    const instruction = raw.match(INSTRUCTION_RE);
    if (!instruction) continue;
    const address = parseAddress(instruction[1]);
    if (address === null) {
      diagnostics.push(`Line ${line}: instruction address exceeds the browser-safe integer range.`);
      continue;
    }
    const bytes = instruction[2].trim().split(/\s+/).filter(Boolean).map((byte) => Number.parseInt(byte, 16));
    const assembly = splitAssembly(instruction[3]);
    if (!assembly.mnemonic) {
      diagnostics.push(`Line ${line}: byte row at 0x${address.toString(16)} has no disassembly text.`);
      continue;
    }
    instructions.push({ line, address, bytes, mnemonic: assembly.mnemonic, operands: assembly.operands, section: currentSection });
  }

  diagnostics.unshift(
    `Disassembly dump evidence: ${instructions.length} instruction row(s), ${symbols.length} symbol label(s), ${sections.length} section header(s).`,
    'Addresses, bytes and mnemonics in this text are imported as external evidence only. Canonical binary analysis and execution require authoritative ELF bytes decoded with Capstone.'
  );
  return { instructions, symbols, sections, diagnostics };
}

function directTargetAddress(operands: string): number | null {
  const normalized = operands.replace(/\*/g, '').trim();
  const match = normalized.match(DIRECT_ADDRESS_RE);
  if (!match) return null;
  return parseAddress(match[1]);
}

export function analyzeDisassemblyDump(fileId: string, source: string): AnalysisGraph {
  const document = parseDisassemblyDump(source);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const instructionNodeByAddress = new Map<number, string>();

  for (const symbol of document.symbols) {
    const id = `${fileId}:dump:symbol:${symbol.address.toString(16)}:${symbol.line}`;
    labels.set(symbol.name, id);
    nodes.push({
      id,
      line: symbol.line,
      address: symbol.address,
      title: symbol.name,
      detail: `0x${symbol.address.toString(16)} · disassembly symbol evidence`,
      kind: 'label',
      evidence: 'Imported from disassembly dump text; not authoritative ELF symbol data.'
    });
  }

  for (const instruction of document.instructions) {
    const id = `${fileId}:dump:insn:${instruction.address.toString(16)}:${instruction.line}`;
    instructionNodeByAddress.set(instruction.address, id);
    nodes.push({
      id,
      line: instruction.line,
      address: instruction.address,
      title: `${instruction.mnemonic}${instruction.operands ? ` ${instruction.operands}` : ''}`,
      detail: `0x${instruction.address.toString(16)} · ${instruction.bytes.length} byte${instruction.bytes.length === 1 ? '' : 's'}${instruction.section ? ` · ${instruction.section}` : ''}`,
      kind: instructionKind(instruction.mnemonic),
      mnemonic: instruction.mnemonic,
      operands: instruction.operands,
      bytes: instruction.bytes,
      evidence: 'Imported disassembly row; use ELF bytes + Capstone for canonical instruction truth.'
    });
  }

  for (let index = 0; index < document.instructions.length - 1; index += 1) {
    const current = document.instructions[index];
    const next = document.instructions[index + 1];
    const currentId = instructionNodeByAddress.get(current.address)!;
    const nextId = instructionNodeByAddress.get(next.address)!;
    const op = current.mnemonic.toLowerCase();
    const terminal = op === 'ret' || op === 'retq' || op === 'ud2' || op === 'hlt';
    const unconditionalJump = op === 'jmp' || op === 'jmpq';
    if (!terminal && !unconditionalJump && current.address + current.bytes.length === next.address) {
      edges.push({ id: `${fileId}:dump:seq:${current.address.toString(16)}:${next.address.toString(16)}`, from: currentId, to: nextId, kind: 'control', label: 'dump order' });
    }
  }

  for (const instruction of document.instructions) {
    const kind = instructionKind(instruction.mnemonic);
    if (kind !== 'branch' && kind !== 'call') continue;
    const targetAddress = directTargetAddress(instruction.operands);
    if (targetAddress === null) continue;
    const from = instructionNodeByAddress.get(instruction.address);
    const to = instructionNodeByAddress.get(targetAddress);
    if (!from || !to) continue;
    edges.push({
      id: `${fileId}:dump:${kind}:${instruction.address.toString(16)}:${targetAddress.toString(16)}`,
      from,
      to,
      kind: kind === 'call' ? 'call' : 'branch',
      label: `${kind} evidence`
    });
  }

  return {
    fileId,
    nodes,
    edges,
    labels,
    diagnostics: document.diagnostics,
    sourceKind: 'disassembly-dump',
    architecture: 'x86-64',
    entryAddress: document.instructions[0]?.address,
    viewKind: 'source-flow'
  };
}
