import type { ProjectFile } from '../project/model';
import { loadCapstone } from '../capstone/capstoneLoader';
import { executableBytesForRange, parseElfImage } from '../binary/elfParser';
import { decodeFunctionCandidate, discoverBinaryFunctions } from '../binary/functionDiscovery';
import { recoverPltStubs } from '../binary/linkage';
import type {
  BinaryAnalysisSummary,
  BinaryFunctionCandidate,
  CanonicalInstruction,
  ElfPltStub,
  LoadedImage
} from '../binary/model';
import type { AnalysisGraph, GraphEdge, GraphNode } from './model';
import { decodeX86_64 } from '../capstone/capstoneDecoder';
import type { CapstoneModule } from '../capstone/types';

export interface BinaryAnalysisResult {
  graph: AnalysisGraph;
  summary: BinaryAnalysisSummary;
  capstoneVersion: string;
}

function instructionTitle(instruction: CanonicalInstruction): string {
  return instruction.operands ? `${instruction.mnemonic} ${instruction.operands}` : instruction.mnemonic;
}

function nodeKind(instruction: CanonicalInstruction): GraphNode['kind'] {
  if (instruction.controlFlow === 'syscall') return 'syscall';
  if (instruction.controlFlow === 'call') return 'call';
  if (instruction.controlFlow === 'jump') return 'branch';
  return 'instruction';
}

function candidateContaining(functions: BinaryFunctionCandidate[], address: number): BinaryFunctionCandidate | null {
  const exact = functions.find((candidate) => candidate.address === address);
  if (exact) return exact;
  return functions
    .filter((candidate) => candidate.endAddress !== null && address >= candidate.address && address < candidate.endAddress)
    .sort((left, right) => (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER))[0] ?? null;
}

function fallbackRoot(image: LoadedImage): BinaryFunctionCandidate {
  const executable = image.sections.find((section) => section.executable && section.size > 0 && !['.plt', '.plt.sec', '.plt.got'].includes(section.name));
  if (!executable) throw new Error('ELF contains no executable section.');
  const address = image.entry && image.entry >= executable.address && image.entry < executable.address + executable.size ? image.entry : executable.address;
  return {
    address,
    endAddress: null,
    size: null,
    name: `sub_${address.toString(16)}`,
    sectionIndex: executable.index,
    sectionName: executable.name,
    kind: image.entry === address ? 'entrypoint' : 'section-entry',
    confidence: 'inferred',
    evidence: image.entry === address ? 'ELF e_entry fallback.' : 'Executable section fallback.',
    symbol: null,
    unwindFde: null,
    leadingPaddingBytes: 0
  };
}

function decodeRoot(image: LoadedImage, buffer: ArrayBuffer, module: CapstoneModule, root: BinaryFunctionCandidate): CanonicalInstruction[] {
  try {
    return decodeFunctionCandidate(image, buffer, module, root);
  } catch {
    const section = image.sections[root.sectionIndex];
    if (!section) throw new Error(`No executable section for root ${root.name}.`);
    const maxBytes = Math.min(64 * 1024, Math.max(1, section.address + section.size - root.address));
    const bytes = executableBytesForRange(image, buffer, root.address, maxBytes);
    return decodeX86_64(module, bytes, root.address, { maxInstructions: 8192, stopAtReturn: true });
  }
}

function ensureReferenceNode(
  nodes: GraphNode[],
  labels: Map<string, string>,
  fileId: string,
  target: BinaryFunctionCandidate | ElfPltStub,
  kind: 'function' | 'plt'
): string {
  const address = target.address;
  const id = `${fileId}:${kind}:${address.toString(16)}`;
  if (nodes.some((node) => node.id === id)) return id;
  const title = target.name;
  const evidence = kind === 'plt' ? (target as ElfPltStub).evidence : (target as BinaryFunctionCandidate).evidence;
  const detail = kind === 'plt'
    ? `0x${address.toString(16)} · ${(target as ElfPltStub).sectionName} · GOT 0x${(target as ElfPltStub).gotAddress.toString(16)}`
    : `0x${address.toString(16)} · ${(target as BinaryFunctionCandidate).kind} · ${(target as BinaryFunctionCandidate).confidence}`;
  nodes.push({ id, line: 0, address, title, detail, kind: 'label', evidence });
  labels.set(title, id);
  return id;
}

export async function analyzeBinary(file: ProjectFile): Promise<BinaryAnalysisResult> {
  if (file.kind !== 'binary' || !file.bytes) throw new Error('Binary analysis requires imported bytes.');
  const image = parseElfImage(file.id, file.path, file.bytes);
  const module = await loadCapstone();
  const discovery = discoverBinaryFunctions(image, file.bytes, module);
  const linkage = recoverPltStubs(image, file.bytes, module);
  const root = candidateContaining(discovery.functions, image.entry) ?? discovery.functions[0] ?? fallbackRoot(image);
  const instructions = decodeRoot(image, file.bytes, module, root);
  if (!instructions.length) throw new Error(`Capstone decoded zero instructions at 0x${root.address.toString(16)}.`);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const rootNodeId = `${file.id}:fn:${root.address.toString(16)}`;
  nodes.push({
    id: rootNodeId,
    line: 0,
    address: root.address,
    title: root.name,
    detail: `0x${root.address.toString(16)} · ${instructions.length} instructions · ${root.kind}`,
    kind: 'label',
    evidence: root.evidence
  });
  labels.set(root.name, rootNodeId);

  const nodeByAddress = new Map<number, string>();
  for (const instruction of instructions) {
    const id = `${file.id}:addr:${instruction.address.toString(16)}`;
    nodeByAddress.set(instruction.address, id);
    nodes.push({
      id,
      line: 0,
      address: instruction.address,
      title: instructionTitle(instruction),
      detail: `0x${instruction.address.toString(16)} · ${instruction.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}`,
      kind: nodeKind(instruction),
      evidence: instruction.evidence,
      registerReads: instruction.registerReads,
      registerWrites: instruction.registerWrites,
      bytes: instruction.bytes,
      operandDetails: instruction.operandDetails,
      memoryOperands: instruction.memoryOperands
    });
  }

  if (instructions[0]) edges.push({ id: `${rootNodeId}:entry`, from: rootNodeId, to: nodeByAddress.get(instructions[0].address)!, kind: 'control' });

  const functionsByAddress = new Map(discovery.functions.map((candidate) => [candidate.address, candidate]));
  const pltByAddress = new Map(linkage.stubs.map((stub) => [stub.address, stub]));
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    const current = nodeByAddress.get(instruction.address)!;
    const next = instructions[index + 1];
    const unconditionalJump = instruction.controlFlow === 'jump' && /^(?:jmp|jmpq|ljmp)$/i.test(instruction.mnemonic);
    if (next && instruction.controlFlow !== 'return' && !unconditionalJump) {
      edges.push({ id: `${current}:next:${next.address}`, from: current, to: nodeByAddress.get(next.address)!, kind: 'control' });
    }
    if (instruction.directTarget === null) continue;
    const localTarget = nodeByAddress.get(instruction.directTarget);
    if (localTarget) {
      edges.push({
        id: `${current}:${instruction.controlFlow}:${instruction.directTarget}`,
        from: current,
        to: localTarget,
        kind: instruction.controlFlow === 'call' ? 'call' : 'branch',
        label: instruction.controlFlow
      });
      continue;
    }
    const plt = pltByAddress.get(instruction.directTarget);
    const functionTarget = functionsByAddress.get(instruction.directTarget);
    if (plt) {
      const targetId = ensureReferenceNode(nodes, labels, file.id, plt, 'plt');
      edges.push({ id: `${current}:plt:${plt.address}`, from: current, to: targetId, kind: 'call', label: plt.ifunc ? 'ifunc/plt' : 'plt' });
    } else if (functionTarget) {
      const targetId = ensureReferenceNode(nodes, labels, file.id, functionTarget, 'function');
      edges.push({
        id: `${current}:function:${functionTarget.address}`,
        from: current,
        to: targetId,
        kind: instruction.controlFlow === 'call' ? 'call' : 'branch',
        label: instruction.controlFlow
      });
    }
  }

  const encodedVersion = module.version();
  const capstoneVersion = `${encodedVersion >> 8}.${encodedVersion & 0xff}`;
  const diagnostics = [
    `LoadedImage: ELF64 x86-64 ${image.kind}, entry 0x${image.entry.toString(16)}.`,
    `Raw ELF: ${image.segments.length} PT_LOAD mappings, ${image.sections.length} sections, ${image.symbols.length} symbols, ${image.relocations.length} relocations.`,
    `Unwind boundaries: ${image.unwind.fdes.length} preferred FDE range(s), ${image.unwind.errors.length} parse diagnostic(s).`,
    ...discovery.diagnostics,
    ...linkage.diagnostics,
    `Canonical decode: ${instructions.length} instruction(s) via Capstone ${capstoneVersion}; pinned x86 operand-detail layout validated per instruction.`
  ];
  if (image.interpreter) diagnostics.push(`PT_INTERP: ${image.interpreter}.`);
  if (image.buildId) diagnostics.push(`GNU build-id: ${image.buildId}.`);
  if (image.neededLibraries.length) diagnostics.push(`DT_NEEDED: ${image.neededLibraries.join(', ')}.`);

  return {
    graph: {
      fileId: file.id,
      nodes,
      edges,
      labels,
      diagnostics,
      sourceKind: 'raw-elf-capstone',
      architecture: image.architecture,
      entryAddress: image.entry
    },
    summary: {
      image,
      rootName: root.name,
      rootAddress: root.address,
      rootSize: root.size,
      instructions,
      functions: discovery.functions,
      pltStubs: linkage.stubs
    },
    capstoneVersion
  };
}
