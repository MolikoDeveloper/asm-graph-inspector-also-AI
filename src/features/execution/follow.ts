import type { AnalysisGraph, GraphNode } from '../analysis/model';
import type { BinaryAnalysisSummary } from '../binary/model';
import type { ExecutionSnapshot } from './model';

export function executionAddressFromSnapshot(snapshot: ExecutionSnapshot): number | null {
  if (snapshot.status !== 'paused') return null;
  if (snapshot.lastInstruction?.address !== undefined) return snapshot.lastInstruction.address;
  if (snapshot.provider === 'blink-process') {
    const runtimeImage = snapshot.runtimeDisassembly?.image;
    if (!runtimeImage || runtimeImage.role !== 'program') return null;
    const imageAddress = Number(runtimeImage.imageAddress);
    return Number.isSafeInteger(imageAddress) ? imageAddress : null;
  }
  const rip = snapshot.registers?.rip;
  if (rip === null || rip === undefined) return null;
  const value = Number(rip);
  return Number.isSafeInteger(value) ? value : null;
}

export function findBinaryFunctionForAddress(summary: BinaryAnalysisSummary, address: number): number | null {
  const exact = summary.functions.find((candidate) => candidate.address === address);
  if (exact) return exact.address;
  const containing = summary.functions
    .filter((candidate) => candidate.endAddress !== null && address >= candidate.address && address < candidate.endAddress)
    .sort((left, right) => (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER))[0];
  return containing?.address ?? null;
}

export function graphNodeForAddress(graph: AnalysisGraph | null, address: number): GraphNode | null {
  if (!graph) return null;
  for (const node of graph.nodes) {
    if (node.blockInstructions?.length) {
      const first = node.blockInstructions[0];
      const last = node.blockInstructions.at(-1);
      if (first && last && address >= first.address && address < last.endAddress) return node;
    }
    if (node.address === address) return node;
  }
  return null;
}

export function imageContainsExecutableAddress(summary: BinaryAnalysisSummary, address: number): boolean {
  return summary.image.segments.some((segment) => segment.executable && address >= segment.virtualAddress && address < segment.virtualAddress + segment.memorySize);
}

export interface ExecutionTraceProjection {
  nodeCounts: Map<string, number>;
  edgeCounts: Map<string, number>;
  currentNodeId: string | null;
}

function eventNodeId(graph: AnalysisGraph, event: Extract<ExecutionSnapshot['events'][number], { kind: 'instruction' }>): string | null {
  if (event.nodeId && graph.nodes.some((node) => node.id === event.nodeId)) return event.nodeId;
  return graphNodeForAddress(graph, event.address)?.id ?? null;
}

function edgePath(graph: AnalysisGraph, from: string, to: string, maxDepth = 3): string[] {
  if (from === to) return [];
  const outgoing = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.from) ?? [];
    bucket.push(edge);
    outgoing.set(edge.from, bucket);
  }
  const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.path.length >= maxDepth) continue;
    for (const edge of outgoing.get(current.node) ?? []) {
      const path = [...current.path, edge.id];
      if (edge.to === to) return path;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push({ node: edge.to, path });
    }
  }
  return [];
}

export function projectExecutionTrace(graph: AnalysisGraph | null, snapshot: ExecutionSnapshot): ExecutionTraceProjection {
  const nodeCounts = new Map<string, number>();
  const edgeCounts = new Map<string, number>();
  if (!graph || snapshot.targetFileId !== graph.fileId) return { nodeCounts, edgeCounts, currentNodeId: null };

  let previousNodeId: string | null = null;
  for (const event of snapshot.events) {
    if (event.kind === 'trace-gap') {
      previousNodeId = null;
      continue;
    }
    if (event.kind !== 'instruction') continue;
    const nodeId = eventNodeId(graph, event);
    if (!nodeId) { previousNodeId = null; continue; }
    nodeCounts.set(nodeId, (nodeCounts.get(nodeId) ?? 0) + 1);
    if (previousNodeId) {
      for (const edgeId of edgePath(graph, previousNodeId, nodeId)) edgeCounts.set(edgeId, (edgeCounts.get(edgeId) ?? 0) + 1);
    }
    previousNodeId = nodeId;
  }

  let currentNodeId: string | null = null;
  if (snapshot.status === 'paused' || snapshot.status === 'running') {
    if (snapshot.lastInstruction?.nodeId && graph.nodes.some((node) => node.id === snapshot.lastInstruction!.nodeId)) currentNodeId = snapshot.lastInstruction.nodeId;
    else if (snapshot.lastInstruction) currentNodeId = graphNodeForAddress(graph, snapshot.lastInstruction.address)?.id ?? null;
  }
  return { nodeCounts, edgeCounts, currentNodeId };
}
