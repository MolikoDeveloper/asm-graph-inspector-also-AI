import type { AnalysisGraph, GraphNode } from './model';

export interface PositionedGraphNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

function layoutFunctionCfg(graph: AnalysisGraph): PositionedGraphNode[] {
  const blocks = graph.nodes.filter((node) => node.blockInstructions?.length);
  const references = graph.nodes.filter((node) => !node.blockInstructions?.length);
  const result: PositionedGraphNode[] = [];
  const blockPosition = new Map<string, { x: number; y: number }>();
  for (let index = 0; index < blocks.length; index += 1) {
    const node = blocks[index];
    const x = 180 + (index % 2 === 1 && graph.edges.some((edge) => edge.to === node.id && edge.kind === 'branch') ? 44 : 0);
    const y = 48 + index * 92;
    blockPosition.set(node.id, { x, y });
    result.push({ ...node, x, y, width: 270, height: 58 });
  }
  const occupiedRows = new Map<number, number>();
  for (const node of references) {
    const incoming = graph.edges.find((edge) => edge.to === node.id);
    const source = incoming ? blockPosition.get(incoming.from) : null;
    const preferredY = source?.y ?? (48 + result.length * 72);
    const row = Math.max(0, Math.round((preferredY - 48) / 64));
    const collision = occupiedRows.get(row) ?? 0;
    occupiedRows.set(row, collision + 1);
    result.push({ ...node, x: 520 + collision * 225, y: 48 + row * 64, width: 205, height: 46 });
  }
  return result;
}


function layoutDataflow(graph: AnalysisGraph): PositionedGraphNode[] {
  return graph.nodes.map((node, index) => {
    const lane = Boolean(node.dataflowLane);
    const value = Boolean(node.dataflowValueKind);
    const width = lane ? Math.max(118, Math.min(230, 34 + node.title.length * 7)) : value ? 210 : 250;
    const height = lane ? 34 : value ? 48 : 56;
    return {
      ...node,
      x: node.x ?? (value ? 24 : 250),
      y: node.y ?? (48 + index * 72),
      width,
      height
    };
  });
}

export function layoutGraph(graph: AnalysisGraph): PositionedGraphNode[] {
  if (graph.viewKind === 'function-cfg') return layoutFunctionCfg(graph);
  if (graph.viewKind === 'dataflow') return layoutDataflow(graph);
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
