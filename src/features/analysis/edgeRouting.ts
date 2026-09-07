import type { AnalysisGraph, GraphEdge } from './model';
import type { PositionedGraphNode } from './layout';

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RoutedGraphEdge {
  points: GraphPoint[];
  label: GraphPoint;
  arrowDx: number;
  arrowDy: number;
  loop: boolean;
}

interface RouteInput {
  graph: AnalysisGraph;
  edge: GraphEdge;
  from: PositionedGraphNode;
  to: PositionedGraphNode;
  nodes: PositionedGraphNode[];
  bounds: GraphBounds | null;
  loopLane?: number;
  structural?: boolean;
}

const NODE_CLEARANCE = 12;
const NORMAL_LANE_GAP = 28;
const LOOP_LANE_GAP = 34;
const LOOP_LANE_STEP = 24;

function centerX(node: PositionedGraphNode): number { return node.x + node.width * 0.5; }
function centerY(node: PositionedGraphNode): number { return node.y + node.height * 0.5; }

function horizontalOverlap(a: PositionedGraphNode, b: PositionedGraphNode, padding = 0): boolean {
  return a.x - padding < b.x + b.width && a.x + a.width + padding > b.x;
}

function verticalOverlap(a: PositionedGraphNode, b: PositionedGraphNode, padding = 0): boolean {
  return a.y - padding < b.y + b.height && a.y + a.height + padding > b.y;
}

function axisSegmentHitsNode(a: GraphPoint, b: GraphPoint, node: PositionedGraphNode, padding = NODE_CLEARANCE): boolean {
  const left = node.x - padding;
  const right = node.x + node.width + padding;
  const top = node.y - padding;
  const bottom = node.y + node.height + padding;
  const epsilon = 0.001;

  if (Math.abs(a.x - b.x) <= epsilon) {
    if (a.x <= left || a.x >= right) return false;
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return maxY > top && minY < bottom;
  }
  if (Math.abs(a.y - b.y) <= epsilon) {
    if (a.y <= top || a.y >= bottom) return false;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return maxX > left && minX < right;
  }

  // Router emits orthogonal segments. Treat a future diagonal conservatively by
  // checking its bounding box rather than allowing it to cross a node silently.
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return maxX > left && minX < right && maxY > top && minY < bottom;
}

export function routeCrossesNode(points: GraphPoint[], node: PositionedGraphNode): boolean {
  for (let index = 1; index < points.length; index += 1) {
    if (axisSegmentHitsNode(points[index - 1], points[index], node)) return true;
  }
  return false;
}

function routeCollisionCount(points: GraphPoint[], nodes: PositionedGraphNode[], fromId: string, toId: string): number {
  let collisions = 0;
  for (const node of nodes) {
    if (node.id === fromId || node.id === toId) continue;
    if (routeCrossesNode(points, node)) collisions += 1;
  }
  return collisions;
}

function routeLength(points: GraphPoint[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.abs(points[index].x - points[index - 1].x) + Math.abs(points[index].y - points[index - 1].y);
  }
  return length;
}

function compactPoints(points: GraphPoint[]): GraphPoint[] {
  const result: GraphPoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    result.push(point);
  }
  for (let index = result.length - 2; index > 0; index -= 1) {
    const a = result[index - 1];
    const b = result[index];
    const c = result[index + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) result.splice(index, 1);
  }
  return result;
}

function chooseRoute(candidates: GraphPoint[][], nodes: PositionedGraphNode[], fromId: string, toId: string): GraphPoint[] {
  let best = compactPoints(candidates[0]);
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const compact = compactPoints(candidate);
    const collisions = routeCollisionCount(compact, nodes, fromId, toId);
    const score = collisions * 1_000_000 + routeLength(compact) + Math.max(0, compact.length - 2) * 18;
    if (score < bestScore) {
      best = compact;
      bestScore = score;
    }
  }
  return best;
}

function labelPoint(points: GraphPoint[]): GraphPoint {
  let bestIndex = 1;
  let bestLength = -1;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (length > bestLength) {
      bestLength = length;
      bestIndex = index;
    }
  }
  const a = points[bestIndex - 1];
  const b = points[bestIndex];
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

export function isLoopLikeEdge(
  graph: AnalysisGraph,
  edge: GraphEdge,
  from: PositionedGraphNode,
  to: PositionedGraphNode
): boolean {
  if (edge.loopBack) return true;
  if (graph.viewKind !== 'function-cfg') return false;

  // A same-row forward fallthrough is not a loop. The previous `to.y <= from.y`
  // heuristic misclassified sibling blocks and forced their arrows across/around
  // the wrong side of the row. Address evidence or a genuinely higher target is
  // required when loopBack metadata is absent.
  if (to.address !== undefined && from.address !== undefined && to.address < from.address) {
    return edge.kind === 'branch' || edge.kind === 'control';
  }
  return to.y + to.height * 0.35 < from.y;
}

function sideBySideRoute(from: PositionedGraphNode, to: PositionedGraphNode, lane: number): GraphPoint[][] {
  const toRight = centerX(to) >= centerX(from);
  const start = { x: toRight ? from.x + from.width : from.x, y: centerY(from) };
  const end = { x: toRight ? to.x : to.x + to.width, y: centerY(to) };
  const topY = Math.min(from.y, to.y) - NORMAL_LANE_GAP - lane * 14;
  const bottomY = Math.max(from.y + from.height, to.y + to.height) + NORMAL_LANE_GAP + lane * 14;
  return [
    [start, end],
    [start, { x: start.x + (toRight ? NORMAL_LANE_GAP : -NORMAL_LANE_GAP), y: start.y }, { x: start.x + (toRight ? NORMAL_LANE_GAP : -NORMAL_LANE_GAP), y: topY }, { x: end.x + (toRight ? -NORMAL_LANE_GAP : NORMAL_LANE_GAP), y: topY }, { x: end.x + (toRight ? -NORMAL_LANE_GAP : NORMAL_LANE_GAP), y: end.y }, end],
    [start, { x: start.x + (toRight ? NORMAL_LANE_GAP : -NORMAL_LANE_GAP), y: start.y }, { x: start.x + (toRight ? NORMAL_LANE_GAP : -NORMAL_LANE_GAP), y: bottomY }, { x: end.x + (toRight ? -NORMAL_LANE_GAP : NORMAL_LANE_GAP), y: bottomY }, { x: end.x + (toRight ? -NORMAL_LANE_GAP : NORMAL_LANE_GAP), y: end.y }, end]
  ];
}

function forwardRoute(from: PositionedGraphNode, to: PositionedGraphNode, lane: number): GraphPoint[][] {
  const start = { x: centerX(from), y: from.y + from.height };
  const end = { x: centerX(to), y: to.y };
  const naturalMid = start.y + Math.max(NORMAL_LANE_GAP, (end.y - start.y) * 0.5);
  const candidates: GraphPoint[][] = [];
  for (const delta of [0, 24, -24, 48, -48, 72]) {
    const midY = naturalMid + delta + lane * 6;
    candidates.push([start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]);
  }
  return candidates;
}

function loopRoute(
  from: PositionedGraphNode,
  to: PositionedGraphNode,
  bounds: GraphBounds | null,
  lane: number
): GraphPoint[][] {
  const laneOffset = LOOP_LANE_GAP + lane * LOOP_LANE_STEP;
  const sameBand = verticalOverlap(from, to, NODE_CLEARANCE * 2);
  const candidates: GraphPoint[][] = [];

  if (sameBand) {
    // Side-by-side loop/back edge: leave from top/bottom anchors and reserve an
    // outer horizontal lane. This is the case that previously drew over the
    // sibling node when both blocks occupied the same CFG layer.
    const topY = Math.min(from.y, to.y) - laneOffset;
    const bottomY = Math.max(from.y + from.height, to.y + to.height) + laneOffset;
    const startTop = { x: centerX(from), y: from.y };
    const endTop = { x: centerX(to), y: to.y };
    const startBottom = { x: centerX(from), y: from.y + from.height };
    const endBottom = { x: centerX(to), y: to.y + to.height };
    candidates.push(
      [startTop, { x: startTop.x, y: topY }, { x: endTop.x, y: topY }, endTop],
      [startBottom, { x: startBottom.x, y: bottomY }, { x: endBottom.x, y: bottomY }, endBottom]
    );
  }

  const leftX = (bounds?.minX ?? Math.min(from.x, to.x)) - laneOffset;
  const rightX = (bounds?.maxX ?? Math.max(from.x + from.width, to.x + to.width)) + laneOffset;
  const leftStart = { x: from.x, y: centerY(from) };
  const leftEnd = { x: to.x, y: centerY(to) };
  const rightStart = { x: from.x + from.width, y: centerY(from) };
  const rightEnd = { x: to.x + to.width, y: centerY(to) };
  candidates.push(
    [leftStart, { x: leftX, y: leftStart.y }, { x: leftX, y: leftEnd.y }, leftEnd],
    [rightStart, { x: rightX, y: rightStart.y }, { x: rightX, y: rightEnd.y }, rightEnd]
  );
  return candidates;
}

export function routeGraphEdge(input: RouteInput): RoutedGraphEdge {
  const { graph, edge, from, to, nodes, bounds, structural = false } = input;
  const lane = Math.max(0, input.loopLane ?? 0);
  const loop = isLoopLikeEdge(graph, edge, from, to);
  let candidates: GraphPoint[][];

  if (loop) {
    candidates = loopRoute(from, to, bounds, lane);
  } else if (verticalOverlap(from, to, structural ? 8 : 18) && !horizontalOverlap(from, to, 0)) {
    candidates = sideBySideRoute(from, to, lane);
  } else if (to.y >= from.y + from.height * 0.45) {
    candidates = forwardRoute(from, to, lane);
  } else {
    // Non-CFG data/reference edges can legitimately point upward. Reuse the
    // obstacle-aware side routing without labelling them as semantic loops.
    candidates = sideBySideRoute(from, to, lane);
  }

  const points = chooseRoute(candidates, nodes, from.id, to.id);
  const last = points.at(-1)!;
  const previous = points.at(-2) ?? { x: last.x, y: last.y - 1 };
  return {
    points,
    label: labelPoint(points),
    arrowDx: last.x - previous.x,
    arrowDy: last.y - previous.y,
    loop
  };
}
