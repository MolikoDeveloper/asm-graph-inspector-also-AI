import type { ProjectFile } from '../project/model';
import { loadCapstone } from '../capstone/capstoneLoader';
import { executableBytesForRange, parseElfImage } from '../binary/elfParser';
import { decodeFunctionCandidate, discoverBinaryFunctions, type FunctionDiscoveryResult } from '../binary/functionDiscovery';
import { recoverPltStubs } from '../binary/linkage';
import { cfiSummaryForPc } from '../binary/unwind';
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
import { buildFunctionCfg } from './cfg';
import { resolveGlobalDependencies } from '../dependencies/globalDependencyResolver';
import type { GlobalDependencyResolution } from '../dependencies/model';

export interface BinaryAnalysisResult {
  graph: AnalysisGraph;
  summary: BinaryAnalysisSummary;
  capstoneVersion: string;
}

export interface BinaryAnalysisOptions {
  functionAddress?: number;
}

interface PreparedBinaryAnalysis {
  signature: string;
  image: LoadedImage;
  module: CapstoneModule;
  discovery: FunctionDiscoveryResult;
  linkage: ReturnType<typeof recoverPltStubs>;
  capstoneVersion: string;
  dependencies: GlobalDependencyResolution[];
}

const preparedBinaryCache = new Map<string, PreparedBinaryAnalysis>();

function fileSignature(file: ProjectFile): string {
  return `${file.id}:${file.size}:${file.updatedAt}`;
}

async function prepareBinary(file: ProjectFile): Promise<PreparedBinaryAnalysis> {
  if (file.kind !== 'binary' || !file.bytes) throw new Error('Binary analysis requires imported bytes.');
  const signature = fileSignature(file);
  const cached = preparedBinaryCache.get(file.id);
  if (cached?.signature === signature) return cached;
  const image = parseElfImage(file.id, file.path, file.bytes);
  const module = await loadCapstone();
  const discovery = discoverBinaryFunctions(image, file.bytes, module);
  const linkage = recoverPltStubs(image, file.bytes, module);
  const encodedVersion = module.version();
  const dependencies = await resolveGlobalDependencies(image.neededLibraries);
  const prepared = { signature, image, module, discovery, linkage, capstoneVersion: `${encodedVersion >> 8}.${encodedVersion & 0xff}`, dependencies };
  preparedBinaryCache.set(file.id, prepared);
  return prepared;
}

export function clearBinaryAnalysisCache(fileId?: string): void {
  if (fileId) preparedBinaryCache.delete(fileId);
  else preparedBinaryCache.clear();
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
  nodes.push({ id, line: 0, address, title, detail, kind: 'label', evidence, reachable: true });
  labels.set(title, id);
  return id;
}

function blockKind(instructions: CanonicalInstruction[]): GraphNode['kind'] {
  const last = instructions.at(-1);
  if (instructions.some((instruction) => instruction.controlFlow === 'syscall')) return 'syscall';
  if (last?.controlFlow === 'jump') return 'branch';
  if (instructions.some((instruction) => instruction.controlFlow === 'call')) return 'call';
  return 'instruction';
}

export async function analyzeBinary(file: ProjectFile, options: BinaryAnalysisOptions = {}): Promise<BinaryAnalysisResult> {
  if (file.kind !== 'binary' || !file.bytes) throw new Error('Binary analysis requires imported bytes.');
  const { image, module, discovery, linkage, capstoneVersion, dependencies } = await prepareBinary(file);
  const requested = options.functionAddress === undefined ? null : candidateContaining(discovery.functions, options.functionAddress);
  const root = requested ?? candidateContaining(discovery.functions, image.entry) ?? discovery.functions[0] ?? fallbackRoot(image);
  const instructions = decodeRoot(image, file.bytes, module, root);
  if (!instructions.length) throw new Error(`Capstone decoded zero instructions at 0x${root.address.toString(16)}.`);

  const cfg = buildFunctionCfg(instructions, root.address);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const graphIdByBlock = new Map<string, string>();

  for (const block of cfg.blocks) {
    const id = `${file.id}:${root.address.toString(16)}:${block.id}`;
    graphIdByBlock.set(block.id, id);
    const title = block.id === cfg.entryBlockId ? `entry · 0x${block.startAddress.toString(16)}` : `block_${block.index} · 0x${block.startAddress.toString(16)}`;
    const cfiSummary = cfiSummaryForPc(image.unwind, block.startAddress) ?? undefined;
    nodes.push({
      id,
      line: 0,
      address: block.startAddress,
      title,
      detail: `0x${block.startAddress.toString(16)}..0x${block.endAddress.toString(16)} · ${block.instructions.length} instruction${block.instructions.length === 1 ? '' : 's'}`,
      kind: blockKind(block.instructions),
      evidence: `Canonical CFG block from Capstone decode of ${root.name}.`,
      blockInstructions: block.instructions,
      cfiSummary,
      reachable: block.reachable
    });
  }

  for (const edge of cfg.edges) {
    const from = graphIdByBlock.get(edge.from);
    const to = graphIdByBlock.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      id: `${file.id}:${root.address.toString(16)}:${edge.id}`,
      from,
      to,
      kind: edge.kind === 'branch' ? 'branch' : 'control',
      label: edge.label
    });
  }

  const functionsByAddress = new Map(discovery.functions.map((candidate) => [candidate.address, candidate]));
  const pltByAddress = new Map(linkage.stubs.map((stub) => [stub.address, stub]));
  for (const block of cfg.blocks) {
    const from = graphIdByBlock.get(block.id)!;
    for (const instruction of block.instructions) {
      if (instruction.controlFlow !== 'call' || instruction.directTarget === null) continue;
      const plt = pltByAddress.get(instruction.directTarget);
      const functionTarget = functionsByAddress.get(instruction.directTarget);
      if (plt) {
        const targetId = ensureReferenceNode(nodes, labels, file.id, plt, 'plt');
        edges.push({ id: `${from}:call:plt:${plt.address.toString(16)}`, from, to: targetId, kind: 'call', label: plt.ifunc ? 'ifunc/plt' : 'plt' });
      } else if (functionTarget) {
        const targetId = ensureReferenceNode(nodes, labels, file.id, functionTarget, 'function');
        edges.push({ id: `${from}:call:function:${functionTarget.address.toString(16)}`, from, to: targetId, kind: 'call', label: 'call' });
      }
    }
  }

  const diagnostics = [
    `LoadedImage: ELF64 x86-64 ${image.kind}, entry 0x${image.entry.toString(16)}.`,
    `Raw ELF: ${image.segments.length} PT_LOAD mappings, ${image.sections.length} sections, ${image.symbols.length} symbols, ${image.relocations.length} relocations.`,
    `Unwind: ${image.unwind.cies.length} CIE(s), ${image.unwind.fdes.length} preferred FDE range(s), ${image.unwind.cfiRowCount} decoded CFI row(s), ${image.unwind.errors.length + image.unwind.cfiDiagnostics.length} diagnostic(s).`,
    ...discovery.diagnostics,
    ...linkage.diagnostics,
    `Selected function: ${root.name} @ 0x${root.address.toString(16)} · ${instructions.length} canonical instruction(s).`,
    `CFG: ${cfg.blocks.length} basic block(s), ${cfg.edges.length} local edge(s), ${cfg.reachableBlockIds.size} reachable block(s), ${cfg.backEdges.length} back edge(s).`,
    `Canonical decode: Capstone ${capstoneVersion}; pinned x86 operand-detail layout validated per instruction.`
  ];
  if (image.interpreter) diagnostics.push(`PT_INTERP: ${image.interpreter}.`);
  if (image.buildId) diagnostics.push(`GNU build-id: ${image.buildId}.`);
  if (image.neededLibraries.length) diagnostics.push(`DT_NEEDED: ${image.neededLibraries.join(', ')}.`);
  if (dependencies.length) {
    const resolvedCount = dependencies.filter((dependency) => dependency.status === 'resolved').length;
    const permissionCount = dependencies.filter((dependency) => dependency.status === 'permission-required').length;
    diagnostics.push(`Global dependencies: ${resolvedCount}/${dependencies.length} resolved${permissionCount ? `, ${permissionCount} require browser permission` : ''}.`);
    for (const dependency of dependencies) {
      if (dependency.status === 'resolved') diagnostics.push(`Dependency resolved: ${dependency.requestedName} → ${dependency.sourceName ?? dependency.fileName ?? 'global dependency'}.`);
      else if (dependency.status === 'permission-required') diagnostics.push(`Dependency permission required: ${dependency.requestedName} via ${dependency.sourceName ?? 'global directory'}.`);
      else diagnostics.push(`Dependency unresolved: ${dependency.requestedName}.`);
    }
  }

  return {
    graph: {
      fileId: file.id,
      nodes,
      edges,
      labels,
      diagnostics,
      sourceKind: 'raw-elf-capstone',
      architecture: image.architecture,
      entryAddress: image.entry,
      viewKind: 'function-cfg',
      functionAddress: root.address,
      functionName: root.name
    },
    summary: {
      image,
      rootName: root.name,
      rootAddress: root.address,
      rootSize: root.size,
      instructions,
      functions: discovery.functions,
      pltStubs: linkage.stubs,
      dependencies
    },
    capstoneVersion
  };
}
