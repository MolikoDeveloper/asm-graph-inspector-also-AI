import assert from 'node:assert/strict';
import type { AnalysisGraph, GraphEdge, GraphNode } from '../../src/features/analysis/model';
import { isLoopLikeEdge, routeCrossesNode, routeGraphEdge } from '../../src/features/analysis/edgeRouting';
import type { PositionedGraphNode } from '../../src/features/analysis/layout';

function node(id: string, address: number, x: number, y: number, width = 180, height = 80): PositionedGraphNode {
  const base: GraphNode = { id, line: 1, address, title: id, detail: '', kind: 'branch' };
  return { ...base, x, y, width, height };
}

function edge(id: string, from: string, to: string, kind: GraphEdge['kind'], loopBack = false): GraphEdge {
  return { id, from, to, kind, loopBack };
}

const a = node('a', 0x401000, 80, 80);
const b = node('b', 0x401020, 360, 80);
const blocker = node('blocker', 0x401010, 270, 220, 180, 90);
const lower = node('lower', 0x401040, 360, 360);
const graph: AnalysisGraph = {
  fileId: 'fixture',
  nodes: [a, b, blocker, lower],
  edges: [],
  labels: new Map(),
  diagnostics: [],
  sourceKind: 'raw-elf-capstone',
  architecture: 'x86-64',
  viewKind: 'function-cfg',
  functionAddress: a.address,
  functionName: 'fixture'
};
const nodes = [a, b, blocker, lower];
const bounds = { minX: 50, minY: 50, maxX: 570, maxY: 470 };

const forwardSibling = edge('forward', 'a', 'b', 'control');
assert.equal(isLoopLikeEdge(graph, forwardSibling, a, b), false, 'same-row forward sibling must not be classified as a loop');
const forwardRoute = routeGraphEdge({ graph, edge: forwardSibling, from: a, to: b, nodes, bounds });
assert.equal(forwardRoute.loop, false);
assert.equal(routeCrossesNode(forwardRoute.points, blocker), false, 'normal sibling route must not cross an unrelated node');

const sideLoop = edge('side-loop', 'b', 'a', 'branch', true);
assert.equal(isLoopLikeEdge(graph, sideLoop, b, a), true);
const sideLoopRoute = routeGraphEdge({ graph, edge: sideLoop, from: b, to: a, nodes, bounds, loopLane: 0 });
assert.equal(sideLoopRoute.loop, true);
assert.ok(sideLoopRoute.points.length >= 4, 'loop route should reserve an orthogonal outer lane');
assert.equal(routeCrossesNode(sideLoopRoute.points, blocker), false, 'side-by-side loop must route outside the blocker');

const upward = edge('upward', 'lower', 'a', 'branch', true);
const upwardRoute = routeGraphEdge({ graph, edge: upward, from: lower, to: a, nodes, bounds, loopLane: 1 });
assert.equal(upwardRoute.loop, true);
assert.equal(routeCrossesNode(upwardRoute.points, blocker), false, 'vertical back-edge must avoid the intervening block');

const backwardByAddress = edge('backward-address', 'b', 'a', 'branch');
assert.equal(isLoopLikeEdge(graph, backwardByAddress, b, a), true, 'backward branch address is loop evidence even without explicit loopBack metadata');

console.log('edge routing smoke passed · sibling fallthrough + side loop + vertical back-edge avoid node boxes');
