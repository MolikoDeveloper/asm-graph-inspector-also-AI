import assert from 'node:assert/strict';
import { projectGraphSelection } from '../../src/features/analysis/graphSelection';
import type { AnalysisGraph } from '../../src/features/analysis/model';

const graph: AnalysisGraph = {
  fileId: 'selection-fixture',
  nodes: [
    { id: 'a', line: 0, title: 'A', detail: '', kind: 'instruction' },
    { id: 'b', line: 0, title: 'B', detail: '', kind: 'branch' },
    { id: 'c', line: 0, title: 'C', detail: '', kind: 'instruction' },
    { id: 'd', line: 0, title: 'D', detail: '', kind: 'instruction' },
    { id: 'e', line: 0, title: 'E', detail: '', kind: 'instruction' },
    { id: 'x', line: 0, title: 'unrelated', detail: '', kind: 'instruction' }
  ],
  edges: [
    { id: 'a-b', from: 'a', to: 'b', kind: 'control' },
    { id: 'e-b', from: 'e', to: 'b', kind: 'control' },
    { id: 'b-c', from: 'b', to: 'c', kind: 'branch', label: 'jne' },
    { id: 'c-d', from: 'c', to: 'd', kind: 'control' },
    { id: 'c-b-loop', from: 'c', to: 'b', kind: 'branch', label: 'loop', loopBack: true },
    // Both endpoints become highlighted through b, but this bypass edge is not itself on an
    // incoming-to-b or outgoing-from-b traversal and must therefore remain unhighlighted.
    { id: 'a-d-bypass', from: 'a', to: 'd', kind: 'call' }
  ],
  labels: new Map(),
  diagnostics: [],
  viewKind: 'function-cfg'
};

const projection = projectGraphSelection(graph, 'b');
assert.deepEqual([...projection.nodeIds].sort(), ['a', 'b', 'c', 'd', 'e']);
assert.ok(projection.edgeIds.has('a-b'));
assert.ok(projection.edgeIds.has('e-b'));
assert.ok(projection.edgeIds.has('b-c'));
assert.ok(projection.edgeIds.has('c-d'));
assert.ok(projection.edgeIds.has('c-b-loop'));
assert.equal(projection.edgeIds.has('a-d-bypass'), false, 'bypass edge must not be highlighted merely because its endpoints are highlighted');
assert.equal(projection.nodeIds.has('x'), false);

const empty = projectGraphSelection(graph, 'missing');
assert.equal(empty.nodeIds.size, 0);
assert.equal(empty.edgeIds.size, 0);

console.log('graph interaction smoke passed · direct + indirect predecessors/successors + loop cycle + bypass exclusion');
