import type { AnalysisGraph, GraphNode } from './model';

export interface PositionedGraphNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CFG_BLOCK_WIDTH = 264;
const CFG_COLUMN_GAP = 54;
const CFG_ROW_GAP = 72;
const CFG_MAX_VISIBLE_INSTRUCTIONS = 6;

function functionCfgBlockHeight(node: GraphNode): number {
  const count = Math.min(CFG_MAX_VISIBLE_INSTRUCTIONS, node.blockInstructions?.length ?? 0);
  const overflow = (node.blockInstructions?.length ?? 0) > CFG_MAX_VISIBLE_INSTRUCTIONS;
  return 42 + count * 17 + (overflow ? 16 : 0) + 12;
}

function layoutFunctionCfg(graph: AnalysisGraph): PositionedGraphNode[] {
  const blocks = graph.nodes.filter((node) => node.blockInstructions?.length);
  const references = graph.nodes.filter((node) => !node.blockInstructions?.length);
  if (!blocks.length) return [];

  const blockIds = new Set(blocks.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map(blocks.map((node) => [node.id, 0] as const));

  for (const edge of graph.edges) {
    if (!blockIds.has(edge.from) || !blockIds.has(edge.to) || edge.from === edge.to) continue;
    const list = outgoing.get(edge.from) ?? [];
    if (!list.includes(edge.to)) list.push(edge.to);
    outgoing.set(edge.from, list);
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  }

  const entry = blocks.find((node) => node.address === graph.functionAddress) ?? blocks[0];
  const roots = blocks.filter((node) => (incomingCount.get(node.id) ?? 0) === 0);
  if (!roots.some((node) => node.id === entry.id)) roots.unshift(entry);

  const depth = new Map<string, number>();
  const queue = roots.map((node) => node.id);
  for (const id of queue) if (!depth.has(id)) depth.set(id, 0);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const from = queue[cursor];
    const nextDepth = (depth.get(from) ?? 0) + 1;
    for (const to of outgoing.get(from) ?? []) {
      if (depth.has(to)) continue; // back/cycle edges do not create new layout layers
      depth.set(to, nextDepth);
      queue.push(to);
    }
  }

  let orphanDepth = Math.max(0, ...depth.values()) + 1;
  for (const node of blocks) {
    if (depth.has(node.id)) continue;
    depth.set(node.id, orphanDepth);
    orphanDepth += 1;
  }

  const byDepth = new Map<number, GraphNode[]>();
  for (const node of blocks) {
    const layer = depth.get(node.id) ?? 0;
    const list = byDepth.get(layer) ?? [];
    list.push(node);
    byDepth.set(layer, list);
  }

  for (const list of byDepth.values()) {
    list.sort((a, b) => (a.address ?? Number.MAX_SAFE_INTEGER) - (b.address ?? Number.MAX_SAFE_INTEGER));
  }

  const maxColumns = Math.max(1, ...[...byDepth.values()].map((list) => list.length));
  const canvasWidth = maxColumns * CFG_BLOCK_WIDTH + Math.max(0, maxColumns - 1) * CFG_COLUMN_GAP;
  const result: PositionedGraphNode[] = [];
  const blockPosition = new Map<string, PositionedGraphNode>();
  let y = 48;

  for (const layer of [...byDepth.keys()].sort((a, b) => a - b)) {
    const list = byDepth.get(layer)!;
    const rowWidth = list.length * CFG_BLOCK_WIDTH + Math.max(0, list.length - 1) * CFG_COLUMN_GAP;
    const rowX = 64 + (canvasWidth - rowWidth) * 0.5;
    const rowHeight = Math.max(...list.map(functionCfgBlockHeight));

    for (let index = 0; index < list.length; index += 1) {
      const node = list[index];
      const positioned: PositionedGraphNode = {
        ...node,
        x: rowX + index * (CFG_BLOCK_WIDTH + CFG_COLUMN_GAP),
        y,
        width: CFG_BLOCK_WIDTH,
        height: functionCfgBlockHeight(node)
      };
      result.push(positioned);
      blockPosition.set(node.id, positioned);
    }
    y += rowHeight + CFG_ROW_GAP;
  }

  if (references.length) {
    const referenceX = 64 + canvasWidth + 94;
    const occupiedRows = new Map<number, number>();
    for (const node of references) {
      const incoming = graph.edges.find((edge) => edge.to === node.id);
      const source = incoming ? blockPosition.get(incoming.from) : null;
      const preferredY = source?.y ?? 48;
      const row = Math.max(0, Math.round((preferredY - 48) / 58));
      const collision = occupiedRows.get(row) ?? 0;
      occupiedRows.set(row, collision + 1);
      result.push({
        ...node,
        x: referenceX + collision * 220,
        y: 48 + row * 58,
        width: 196,
        height: 46
      });
    }
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
