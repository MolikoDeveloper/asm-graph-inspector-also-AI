import type { AnalysisGraph, GraphEdge, GraphNode, GraphNodeKind } from './model';

const LABEL_PREFIX_RE = /^\s*([.$A-Za-z_][\w.$@?]*):\s*(.*)$/;
const INSTRUCTION_RE = /^\s*([A-Za-z][\w.]*)\s*(.*?)\s*$/;
const DIRECT_TARGET_RE = /^(?:short\s+|near\s+)?([.$A-Za-z_][\w.$@?]*|0x[0-9a-f]+)$/i;
const DIRECTIVE_RE = /^\s*(section|segment|global|extern|bits|default|align|org|gsection|cpu|use16|use32|use64)\b/i;
const DATA_RE = /^\s*[A-Za-z_.$][\w.$@?]*:?\s+(db|dw|dd|dq|dt|do|dy|dz|resb|resw|resd|resq|rest|reso|resy|resz|equ|times)\b/i;
const PREPROCESSOR_RE = /^\s*%/;
const ZERO_OPERAND = new Set([
  'ret', 'retq', 'iret', 'iretq', 'nop', 'syscall', 'sysenter', 'sysexit', 'leave', 'hlt', 'ud2', 'pause',
  'clc', 'cld', 'cli', 'cmc', 'stc', 'std', 'sti', 'lahf', 'sahf', 'pushf', 'pushfq', 'popf', 'popfq',
  'endbr64', 'endbr32', 'int3', 'cpuid', 'rdtsc', 'rdtscp', 'xlat', 'xlatb'
]);
const REQUIRED_OPERAND_PREFIXES = ['j', 'loop', 'set', 'cmov'];
const REQUIRED_OPERAND = new Set([
  'mov', 'movzx', 'movsx', 'movsxd', 'lea', 'push', 'pop', 'call', 'callq', 'jmp', 'inc', 'dec', 'neg', 'not',
  'add', 'adc', 'sub', 'sbb', 'and', 'or', 'xor', 'cmp', 'test', 'shl', 'shr', 'sar', 'sal', 'rol', 'ror', 'rcl', 'rcr',
  'imul', 'mul', 'idiv', 'div', 'bt', 'btc', 'btr', 'bts', 'bsf', 'bsr', 'tzcnt', 'lzcnt', 'popcnt', 'xchg'
]);

export interface AssemblyProblem {
  id: string;
  fileId: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface AssemblyAnalysisCandidate {
  graph: AnalysisGraph;
  problems: AssemblyProblem[];
  valid: boolean;
}

function kindForMnemonic(mnemonic: string): GraphNodeKind {
  const op = mnemonic.toLowerCase();
  if (op === 'syscall' || op === 'sysenter' || op === 'int') return 'syscall';
  if (op === 'call' || op === 'callq') return 'call';
  if (op === 'jmp' || op.startsWith('j') || op.startsWith('loop')) return 'branch';
  return 'instruction';
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

function syntaxProblem(fileId: string, line: number, column: number, message: string): AssemblyProblem {
  return { id: `${fileId}:${line}:${column}:${message}`, fileId, line, column, severity: 'error', message };
}

function validateDelimiters(fileId: string, lineNumber: number, code: string): AssemblyProblem[] {
  const problems: AssemblyProblem[] = [];
  const stack: Array<{ char: string; column: number }> = [];
  let quote: { char: string; column: number } | null = null;
  const closing: Record<string, string> = { ']': '[', ')': '(', '}': '{' };
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote.char) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = { char, column: index + 1 }; continue; }
    if (char === '[' || char === '(' || char === '{') stack.push({ char, column: index + 1 });
    if (char === ']' || char === ')' || char === '}') {
      const open = stack.pop();
      if (!open || open.char !== closing[char]) problems.push(syntaxProblem(fileId, lineNumber, index + 1, `Unmatched “${char}”.`));
    }
  }
  if (quote) problems.push(syntaxProblem(fileId, lineNumber, quote.column, `Unterminated ${quote.char === '"' ? 'double' : 'single'}-quoted string.`));
  for (const open of stack) problems.push(syntaxProblem(fileId, lineNumber, open.column, `Unclosed “${open.char}”.`));
  return problems;
}

function requiresOperand(mnemonic: string): boolean {
  const op = mnemonic.toLowerCase();
  return REQUIRED_OPERAND.has(op) || REQUIRED_OPERAND_PREFIXES.some((prefix) => op.startsWith(prefix));
}

export function analyzeAssemblyChecked(fileId: string, source: string): AssemblyAnalysisCandidate {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const diagnostics: string[] = [];
  const problems: AssemblyProblem[] = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    const withoutComment = stripComment(raw);
    let code = withoutComment.trim();
    if (!code || code.startsWith('#') || PREPROCESSOR_RE.test(code)) continue;

    problems.push(...validateDelimiters(fileId, lineNumber, withoutComment));

    const labelMatch = code.match(LABEL_PREFIX_RE);
    if (labelMatch) {
      const [, label, remainder] = labelMatch;
      const id = `${fileId}:label:${lineNumber}:${label}`;
      if (labels.has(label)) problems.push(syntaxProblem(fileId, lineNumber, Math.max(1, raw.indexOf(label) + 1), `Duplicate label “${label}”.`));
      labels.set(label, id);
      nodes.push({ id, line: lineNumber, title: label, detail: `line ${lineNumber}`, kind: 'label' });
      code = remainder.trim();
      if (!code) continue;
    }

    if (DIRECTIVE_RE.test(code) || DATA_RE.test(code)) continue;
    // Common NASM constant assignment form without a colon: name equ expression.
    if (/^[A-Za-z_.$][\w.$@?]*\s+equ\b/i.test(code)) continue;

    const instructionMatch = code.match(INSTRUCTION_RE);
    if (!instructionMatch) {
      problems.push(syntaxProblem(fileId, lineNumber, 1, 'The line is not valid NASM-style assembly syntax.'));
      continue;
    }

    const [, mnemonic, operandsRaw] = instructionMatch;
    const operands = operandsRaw.trim();
    const op = mnemonic.toLowerCase();
    if (operands.endsWith(',')) problems.push(syntaxProblem(fileId, lineNumber, Math.max(1, raw.lastIndexOf(',') + 1), 'Trailing comma leaves an operand incomplete.'));
    if (operands.startsWith(',')) problems.push(syntaxProblem(fileId, lineNumber, Math.max(1, raw.indexOf(',') + 1), 'Operand list cannot start with a comma.'));
    if (/,,/.test(operands.replace(/\s+/g, ''))) problems.push(syntaxProblem(fileId, lineNumber, Math.max(1, raw.indexOf(',,') + 1), 'Missing operand between commas.'));
    if (!operands && requiresOperand(op) && !ZERO_OPERAND.has(op)) problems.push(syntaxProblem(fileId, lineNumber, Math.max(1, raw.indexOf(mnemonic) + mnemonic.length + 1), `“${mnemonic}” requires an operand.`));

    const id = `${fileId}:insn:${lineNumber}`;
    nodes.push({
      id,
      line: lineNumber,
      title: `${mnemonic}${operands ? ` ${operands}` : ''}`,
      detail: `line ${lineNumber}`,
      kind: kindForMnemonic(mnemonic),
      mnemonic,
      operands
    });
  }

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const current = nodes[index];
    const next = nodes[index + 1];
    const mnemonic = current.mnemonic?.toLowerCase() ?? current.title.split(/\s+/, 1)[0].toLowerCase();
    if (mnemonic === 'ret' || mnemonic === 'retq' || mnemonic === 'ud2') continue;
    if (mnemonic === 'jmp') continue;
    edges.push({ id: `edge:seq:${current.id}:${next.id}`, from: current.id, to: next.id, kind: 'control' });
  }

  for (const node of nodes) {
    if (node.kind !== 'branch' && node.kind !== 'call') continue;
    const targetRaw = node.operands?.trim().split(',')[0]?.trim() ?? '';
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

  if (nodes.length === 0 && source.trim()) diagnostics.push('No ASM instructions were recognized in the active file.');
  if (problems.length) diagnostics.push(`${problems.length} syntax problem${problems.length === 1 ? '' : 's'} detected; analysis candidate was not committed.`);
  const graph: AnalysisGraph = { fileId, nodes, edges, labels, diagnostics, sourceKind: 'asm-source', viewKind: 'source-flow' };
  return { graph, problems, valid: problems.length === 0 };
}

export function analyzeAssembly(fileId: string, source: string): AnalysisGraph {
  return analyzeAssemblyChecked(fileId, source).graph;
}
