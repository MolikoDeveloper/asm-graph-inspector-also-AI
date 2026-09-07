import type { AnalysisGraph } from './model';

export interface GraphSelectionProjection {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  incomingNodeIds: Set<string>;
  incomingEdgeIds: Set<string>;
  outgoingNodeIds: Set<string>;
  outgoingEdgeIds: Set<string>;
}

function emptyProjection(): GraphSelectionProjection {
  return {
    nodeIds: new Set(),
    edgeIds: new Set(),
    incomingNodeIds: new Set(),
    incomingEdgeIds: new Set(),
    outgoingNodeIds: new Set(),
    outgoingEdgeIds: new Set()
  };
}

/**
 * Project every directed predecessor and successor path touching the selected node.
 * This is intentionally graph-topological rather than layout-based: cycles, hidden
 * layout layers and long indirect paths remain correct even when node positions move.
 */
export function projectGraphSelection(graph: AnalysisGraph | null, selectedId: string | null): GraphSelectionProjection {
  if (!graph || !selectedId || !graph.nodes.some((node) => node.id === selectedId)) return emptyProjection();

  const outgoing = new Map<string, typeof graph.edges>();
  const incoming = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.from) ?? [];
    out.push(edge);
    outgoing.set(edge.from, out);
    const inc = incoming.get(edge.to) ?? [];
    inc.push(edge);
    incoming.set(edge.to, inc);
  }

  const outgoingNodeIds = new Set<string>([selectedId]);
  const outgoingEdgeIds = new Set<string>();
  const forwardQueue = [selectedId];
  for (let cursor = 0; cursor < forwardQueue.length; cursor += 1) {
    const from = forwardQueue[cursor];
    for (const edge of outgoing.get(from) ?? []) {
      outgoingEdgeIds.add(edge.id);
      if (outgoingNodeIds.has(edge.to)) continue;
      outgoingNodeIds.add(edge.to);
      forwardQueue.push(edge.to);
    }
  }

  const incomingNodeIds = new Set<string>([selectedId]);
  const incomingEdgeIds = new Set<string>();
  const backwardQueue = [selectedId];
  for (let cursor = 0; cursor < backwardQueue.length; cursor += 1) {
    const to = backwardQueue[cursor];
    for (const edge of incoming.get(to) ?? []) {
      incomingEdgeIds.add(edge.id);
      if (incomingNodeIds.has(edge.from)) continue;
      incomingNodeIds.add(edge.from);
      backwardQueue.push(edge.from);
    }
  }

  return {
    nodeIds: new Set([...incomingNodeIds, ...outgoingNodeIds]),
    edgeIds: new Set([...incomingEdgeIds, ...outgoingEdgeIds]),
    incomingNodeIds,
    incomingEdgeIds,
    outgoingNodeIds,
    outgoingEdgeIds
  };
}
