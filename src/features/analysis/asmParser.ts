import type { AnalysisGraph, GraphEdge, GraphNode, GraphNodeKind } from './model';

const LABEL_RE = /^\s*([.$A-Za-z_][\w.$@?]*):\s*(?:;.*)?$/;
const INSTRUCTION_RE = /^\s*([A-Za-z][\w.]*)\s*(.*?)\s*(?:;.*)?$/;
const DIRECT_TARGET_RE = /^(?:short\s+|near\s+)?([.$A-Za-z_][\w.$@?]*|0x[0-9a-f]+)$/i;

function kindForMnemonic(mnemonic: string): GraphNodeKind {
  const op = mnemonic.toLowerCase();
  if (op === 'syscall' || op === 'sysenter' || op === 'int') return 'syscall';
  if (op === 'call' || op === 'callq') return 'call';
  if (op === 'jmp' || op.startsWith('j') || op.startsWith('loop')) return 'branch';
  return 'instruction';
}

export function analyzeAssembly(fileId: string, source: string): AnalysisGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const diagnostics: string[] = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

    const labelMatch = raw.match(LABEL_RE);
    if (labelMatch) {
      const id = `${fileId}:label:${index + 1}:${labelMatch[1]}`;
      labels.set(labelMatch[1], id);
      nodes.push({
        id,
        line: index + 1,
        title: labelMatch[1],
        detail: `line ${index + 1}`,
        kind: 'label'
      });
      continue;
    }

    if (/^\s*(section|segment|global|extern|bits|default|align|org|gsection)\b/i.test(raw)) continue;
    if (/^\s*[A-Za-z_.$][\w.$@?]*:?\s+(db|dw|dd|dq|dt|equ|times)\b/i.test(raw)) continue;

    const instructionMatch = raw.match(INSTRUCTION_RE);
    if (!instructionMatch) continue;

    const [, mnemonic, operandsRaw] = instructionMatch;
    const operands = operandsRaw.trim();
    const id = `${fileId}:insn:${index + 1}`;
    nodes.push({
      id,
      line: index + 1,
      title: `${mnemonic}${operands ? ` ${operands}` : ''}`,
      detail: `line ${index + 1}`,
      kind: kindForMnemonic(mnemonic)
    });
  }

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const current = nodes[index];
    const next = nodes[index + 1];
    const mnemonic = current.title.split(/\s+/, 1)[0].toLowerCase();
    if (mnemonic === 'ret' || mnemonic === 'retq' || mnemonic === 'ud2') continue;
    if (mnemonic === 'jmp') continue;
    edges.push({
      id: `edge:seq:${current.id}:${next.id}`,
      from: current.id,
      to: next.id,
      kind: 'control'
    });
  }

  for (const node of nodes) {
    if (node.kind !== 'branch' && node.kind !== 'call') continue;
    const parts = node.title.trim().split(/\s+/, 2);
    const targetRaw = parts[1]?.replace(/,$/, '') ?? '';
    const match = targetRaw.match(DIRECT_TARGET_RE);
    if (!match || !labels.has(match[1])) continue;
    const target = labels.get(match[1])!;
    edges.push({
      id: `edge:${node.kind}:${node.id}:${target}`,
      from: node.id,
      to: target,
      kind: node.kind === 'call' ? 'call' : 'branch',
      label: node.kind
    });
  }

  if (nodes.length === 0) diagnostics.push('No ASM instructions were recognized in the active file.');
  return { fileId, nodes, edges, labels, diagnostics, sourceKind: 'asm-source' };
}
