import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import type { BinaryFunctionCandidate } from '../features/binary/model';

interface FunctionLeaf {
  label: string;
  fn: BinaryFunctionCandidate;
}

interface FunctionTreeNode {
  path: string;
  label: string;
  children: FunctionTreeNode[];
  functions: FunctionLeaf[];
  count: number;
}

interface MutableTreeNode {
  path: string;
  label: string;
  children: Map<string, MutableTreeNode>;
  functions: FunctionLeaf[];
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function functionMatches(fn: BinaryFunctionCandidate, query: string): boolean {
  if (!query) return true;
  const address = `0x${fn.address.toString(16)}`;
  return [fn.name, address, fn.kind, fn.confidence, fn.sectionName, fn.evidence]
    .some((value) => value.toLowerCase().includes(query));
}

function functionSegments(fn: BinaryFunctionCandidate): string[] {
  const parts = fn.name.split('.').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [fn.name || `sub_${fn.address.toString(16)}`];
}

function finalizeNode(node: MutableTreeNode): FunctionTreeNode {
  const children = [...node.children.values()]
    .map(finalizeNode)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  const functions = [...node.functions]
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) || a.fn.address - b.fn.address);
  return {
    path: node.path,
    label: node.label,
    children,
    functions,
    count: functions.length + children.reduce((total, child) => total + child.count, 0)
  };
}

function buildTree(functions: BinaryFunctionCandidate[]): FunctionTreeNode {
  const root: MutableTreeNode = { path: '', label: '', children: new Map(), functions: [] };

  for (const fn of functions) {
    const segments = functionSegments(fn);
    const leafLabel = segments.at(-1) ?? fn.name;
    if (segments.length === 1) {
      root.functions.push({ label: leafLabel, fn });
      continue;
    }

    let current = root;
    const pathParts: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      pathParts.push(segment);
      const path = pathParts.join('.');
      let child = current.children.get(segment);
      if (!child) {
        child = { path, label: segment, children: new Map(), functions: [] };
        current.children.set(segment, child);
      }
      current = child;
    }
    current.functions.push({ label: leafLabel, fn });
  }

  return finalizeNode(root);
}

function collectGroupPaths(tree: FunctionTreeNode, output = new Set<string>()): Set<string> {
  for (const child of tree.children) {
    output.add(child.path);
    collectGroupPaths(child, output);
  }
  return output;
}

function FunctionRow({ leaf, depth, activeAddress, onSelect }: {
  leaf: FunctionLeaf;
  depth: number;
  activeAddress: number;
  onSelect(address: number): void;
}) {
  const fn = leaf.fn;
  return (
    <button
      type="button"
      className={`function-tree-function ${fn.address === activeAddress ? 'active' : ''}`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
      onClick={() => onSelect(fn.address)}
      title={fn.name}
    >
      <span className="function-tree-leaf-mark">ƒ</span>
      <span className="function-tree-function-main">
        <strong>{leaf.label}</strong>
        <small>{fn.kind} · {fn.confidence}{fn.size !== null ? ` · ${fn.size} B` : ''}</small>
      </span>
      <code>0x{fn.address.toString(16)}</code>
    </button>
  );
}

function TreeGroup({ node, depth, expanded, activeAddress, onToggle, onSelect }: {
  node: FunctionTreeNode;
  depth: number;
  expanded: Set<string>;
  activeAddress: number;
  onToggle(path: string): void;
  onSelect(address: number): void;
}) {
  const open = expanded.has(node.path);
  return (
    <div className="function-tree-group">
      <button
        type="button"
        className="function-tree-group-row"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onToggle(node.path)}
        title={node.path}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <strong>{node.label}</strong>
        <span>{node.count}</span>
      </button>
      {open ? (
        <div className="function-tree-children">
          {node.children.map((child) => (
            <TreeGroup key={child.path} node={child} depth={depth + 1} expanded={expanded} activeAddress={activeAddress} onToggle={onToggle} onSelect={onSelect} />
          ))}
          {node.functions.map((leaf) => (
            <FunctionRow key={`${leaf.fn.address}:${leaf.fn.name}`} leaf={leaf} depth={depth + 1} activeAddress={activeAddress} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FunctionTree({ functions, activeAddress, onSelect }: {
  functions: BinaryFunctionCandidate[];
  activeAddress: number;
  onSelect(address: number): void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = normalizeQuery(query);
  const filteredFunctions = useMemo(
    () => functions.filter((fn) => functionMatches(fn, normalizedQuery)),
    [functions, normalizedQuery]
  );
  const tree = useMemo(() => buildTree(filteredFunctions), [filteredFunctions]);
  const searchExpanded = useMemo(() => collectGroupPaths(tree), [tree]);
  const functionUniverseKey = useMemo(
    () => functions.map((fn) => `${fn.address.toString(16)}:${fn.name}`).join('|'),
    [functions]
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    // A different binary/function universe starts compact. Selecting another function
    // in the same binary keeps the user's expansion state intact.
    setExpanded(new Set());
  }, [functionUniverseKey]);

  const visibleExpanded = normalizedQuery ? searchExpanded : expanded;
  const toggle = (path: string) => {
    if (normalizedQuery) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="function-tree-shell">
      <div className="function-tree-toolbar">
        <label className="function-tree-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search functions, address, section…"
            spellCheck={false}
          />
          {query ? <button type="button" onClick={() => setQuery('')} title="Clear function search"><X size={12} /></button> : null}
        </label>
        <span>{filteredFunctions.length} / {functions.length}</span>
      </div>
      <div className="function-tree" role="tree" aria-label="Functions grouped by dotted name">
        {tree.children.map((node) => (
          <TreeGroup key={node.path} node={node} depth={0} expanded={visibleExpanded} activeAddress={activeAddress} onToggle={toggle} onSelect={onSelect} />
        ))}
        {tree.functions.map((leaf) => (
          <FunctionRow key={`${leaf.fn.address}:${leaf.fn.name}`} leaf={leaf} depth={0} activeAddress={activeAddress} onSelect={onSelect} />
        ))}
        {!filteredFunctions.length ? <div className="function-tree-empty">No functions match “{query}”.</div> : null}
      </div>
    </div>
  );
}
