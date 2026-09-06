import type { AnalysisGraph, GraphNode } from './model';

export interface PositionedGraphNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function layoutGraph(graph: AnalysisGraph): PositionedGraphNode[] {
  const result: PositionedGraphNode[] = [];
  const rowHeight = 78;
  const baseX = 230;
  let row = 0;

  for (const node of graph.nodes) {
    const indentation = node.kind === 'label' ? -36 : node.kind === 'call' || node.kind === 'syscall' ? 24 : 0;
    result.push({
      ...node,
      x: baseX + indentation,
      y: 56 + row * rowHeight,
      width: node.kind === 'label' ? 180 : 230,
      height: node.kind === 'label' ? 46 : 54
    });
    row += 1;
  }

  return result;
}
