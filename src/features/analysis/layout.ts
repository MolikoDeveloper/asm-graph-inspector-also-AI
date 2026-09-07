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



function layoutProgramFlow(graph: AnalysisGraph): PositionedGraphNode[] {
  const nodes = graph.nodes;
  if (!nodes.length) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>(nodes.map((node) => [node.id, 0] as const));
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }

  const active = nodes.find((node) => graph.functionAddress !== undefined && node.address === graph.functionAddress);
  const activeReachable = new Set<string>();
  if (active) {
    const activeQueue = [active.id];
    for (let cursor = 0; cursor < activeQueue.length; cursor += 1) {
      const id = activeQueue[cursor];
      if (activeReachable.has(id)) continue;
      activeReachable.add(id);
      for (const to of outgoing.get(id) ?? []) if (!activeReachable.has(to)) activeQueue.push(to);
    }
  }
  const roots = nodes.filter((node) => (incomingCount.get(node.id) ?? 0) === 0);
  if (!roots.length && active) roots.push(active);
  if (!roots.length) roots.push(nodes[0]);

  const layer = new Map<string, number>();
  const queue = roots.map((node) => node.id);
  for (const id of queue) layer.set(id, 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const from = queue[cursor];
    const nextLayer = (layer.get(from) ?? 0) + 1;
    for (const to of outgoing.get(from) ?? []) {
      if (layer.has(to)) continue;
      layer.set(to, nextLayer);
      queue.push(to);
    }
  }

  const maxKnownLayer = Math.max(0, ...layer.values());
  for (const node of nodes) if (!layer.has(node.id)) layer.set(node.id, maxKnownLayer + 1);

  const byLayer = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const depth = layer.get(node.id) ?? 0;
    const list = byLayer.get(depth) ?? [];
    list.push(node);
    byLayer.set(depth, list);
  }

  const result: PositionedGraphNode[] = [];
  let yBase = 42;
  for (const depth of [...byLayer.keys()].sort((a, b) => a - b)) {
    const list = byLayer.get(depth)!;
    list.sort((a, b) => {
      const activeLineageDelta = Number(activeReachable.has(b.id)) - Number(activeReachable.has(a.id));
      if (activeLineageDelta) return activeLineageDelta;
      const activeDelta = Number(b.address === graph.functionAddress) - Number(a.address === graph.functionAddress);
      if (activeDelta) return activeDelta;
      const addressA = a.address ?? Number.MAX_SAFE_INTEGER;
      const addressB = b.address ?? Number.MAX_SAFE_INTEGER;
      return addressA - addressB || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
    });
    const columns = Math.min(4, Math.max(1, list.length));
    const rows = Math.ceil(list.length / columns);
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      const column = index % columns;
      const row = Math.floor(index / columns);
      const isGroup = node.kind === 'label';
      result.push({
        ...node,
        x: 56 + column * 282,
        y: yBase + row * 78,
        width: isGroup ? 220 : 252,
        height: isGroup ? 50 : 56
      });
    }
    yBase += Math.max(1, rows) * 78 + 58;
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
  if (graph.viewKind === 'program-flow') return layoutProgramFlow(graph);
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
