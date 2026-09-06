import type { AnalysisGraph, GraphNode } from '../analysis/model';
import type { BinaryAnalysisSummary } from '../binary/model';
import type { ExecutionSnapshot } from './model';

export function executionAddressFromSnapshot(snapshot: ExecutionSnapshot): number | null {
  if (snapshot.status !== 'paused') return null;
  if (snapshot.lastInstruction?.address !== undefined) return snapshot.lastInstruction.address;
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
