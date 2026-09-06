import type { AnalysisGraph, GraphEdge, GraphNode } from './model';
import type { BinaryAnalysisSummary, BinaryFunctionCandidate, ElfPltStub } from '../binary/model';

export type ProgramFlowScope = 'focus' | 'visited' | 'all';

export interface ProgramFlowGroup {
  id: string;
  label: string;
  count: number;
}

export type ProgramFlowNodeAction =
  | { kind: 'function'; address: number }
  | { kind: 'group'; groupId: string }
  | { kind: 'navigate'; address: number };

export interface ProgramFlowModel {
  graph: AnalysisGraph;
  groups: ProgramFlowGroup[];
  actions: Map<string, ProgramFlowNodeAction>;
  visitedCount: number;
}

interface FlowEntity {
  address: number;
  name: string;
  detail: string;
  evidence: string;
  groupId: string;
  groupLabel: string;
  type: 'function' | 'plt';
}

interface RawTransfer {
  fromAddress: number;
  toAddress: number;
  kind: 'call' | 'branch';
}

function topLevelGroup(name: string, type: FlowEntity['type']): { id: string; label: string } {
  if (type === 'plt') return { id: 'plt', label: 'PLT' };
  const head = name.split('.').map((part) => part.trim()).find(Boolean);
  if (!name.includes('.') || !head) return { id: 'root', label: '(root)' };
  return { id: `ns:${head}`, label: head };
}

function functionEntity(fn: BinaryFunctionCandidate): FlowEntity {
  const group = topLevelGroup(fn.name, 'function');
  return {
    address: fn.address,
    name: fn.name,
    detail: `${fn.kind} · ${fn.confidence}${fn.size !== null ? ` · ${fn.size} B` : ''}`,
    evidence: fn.evidence,
    groupId: group.id,
    groupLabel: group.label,
    type: 'function'
  };
}

function pltEntity(stub: ElfPltStub): FlowEntity {
  const group = topLevelGroup(stub.name, 'plt');
  return {
    address: stub.address,
    name: stub.name,
    detail: `${stub.sectionName} · GOT 0x${stub.gotAddress.toString(16)}`,
    evidence: stub.evidence,
    groupId: group.id,
    groupLabel: group.label,
    type: 'plt'
  };
}

function candidateContaining(functions: BinaryFunctionCandidate[], address: number): BinaryFunctionCandidate | null {
  const exact = functions.find((fn) => fn.address === address);
  if (exact) return exact;
  return functions
    .filter((fn) => fn.endAddress !== null && address >= fn.address && address < fn.endAddress)
    .sort((left, right) => (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER))[0] ?? null;
}

function groupNodeId(fileId: string, groupId: string): string {
  return `${fileId}:program-flow:group:${encodeURIComponent(groupId)}`;
}

function entityNodeId(fileId: string, entity: FlowEntity): string {
  return `${fileId}:program-flow:${entity.type}:${entity.address.toString(16)}`;
}

export function buildProgramFlow({
  fileId,
  functions,
  pltStubs,
  summaries,
  activeAddress,
  scope,
  hiddenGroups,
  expandedGroups
}: {
  fileId: string;
  functions: BinaryFunctionCandidate[];
  pltStubs: ElfPltStub[];
  summaries: BinaryAnalysisSummary[];
  activeAddress: number;
  scope: ProgramFlowScope;
  hiddenGroups: Set<string>;
  expandedGroups: Set<string>;
}): ProgramFlowModel {
  const functionEntities = functions.map(functionEntity);
  const pltEntities = pltStubs.map(pltEntity);
  const entityByAddress = new Map<number, FlowEntity>();
  for (const entity of [...functionEntities, ...pltEntities]) entityByAddress.set(entity.address, entity);

  const functionByAddress = new Map(functions.map((fn) => [fn.address, fn]));
  const pltByAddress = new Map(pltStubs.map((stub) => [stub.address, stub]));
  const transfers: RawTransfer[] = [];
  const touchedAddresses = new Set<number>([activeAddress]);
  const visitedAddresses = new Set<number>();

  for (const summary of summaries) {
    visitedAddresses.add(summary.rootAddress);
    touchedAddresses.add(summary.rootAddress);
    for (const instruction of summary.instructions) {
      if ((instruction.controlFlow !== 'call' && instruction.controlFlow !== 'jump') || instruction.directTarget === null) continue;
      const exactFunction = functionByAddress.get(instruction.directTarget);
      const containingFunction = exactFunction ?? candidateContaining(functions, instruction.directTarget);
      const plt = pltByAddress.get(instruction.directTarget);
      const targetAddress = plt?.address ?? containingFunction?.address ?? null;
      if (targetAddress === null) continue;
      touchedAddresses.add(targetAddress);
      transfers.push({
        fromAddress: summary.rootAddress,
        toAddress: targetAddress,
        kind: instruction.controlFlow === 'call' ? 'call' : 'branch'
      });
    }
  }

  const focusAddresses = new Set<number>([activeAddress]);
  for (const transfer of transfers) {
    if (transfer.fromAddress !== activeAddress && transfer.toAddress !== activeAddress) continue;
    focusAddresses.add(transfer.fromAddress);
    focusAddresses.add(transfer.toAddress);
  }
  const scopedAddresses = scope === 'focus' ? focusAddresses : touchedAddresses;

  const groupsById = new Map<string, ProgramFlowGroup>();
  for (const entity of entityByAddress.values()) {
    const existing = groupsById.get(entity.groupId);
    if (existing) existing.count += 1;
    else groupsById.set(entity.groupId, { id: entity.groupId, label: entity.groupLabel, count: 1 });
  }
  const groups = [...groupsById.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));

  const touchedGroups = new Set<string>();
  for (const address of scopedAddresses) {
    const entity = entityByAddress.get(address);
    if (entity) touchedGroups.add(entity.groupId);
  }

  const includedGroups = new Set<string>(
    groups
      .filter((group) => !hiddenGroups.has(group.id) && (scope === 'all' || touchedGroups.has(group.id)))
      .map((group) => group.id)
  );

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const actions = new Map<string, ProgramFlowNodeAction>();
  const nodeIdByAddress = new Map<number, string>();

  const entitiesByGroup = new Map<string, FlowEntity[]>();
  for (const entity of entityByAddress.values()) {
    if (!includedGroups.has(entity.groupId)) continue;
    if (scope !== 'all' && !scopedAddresses.has(entity.address)) continue;
    const list = entitiesByGroup.get(entity.groupId) ?? [];
    list.push(entity);
    entitiesByGroup.set(entity.groupId, list);
  }

  const ensureGroupNode = (groupId: string): string => {
    const existing = groupNodeId(fileId, groupId);
    if (nodes.some((node) => node.id === existing)) return existing;
    const group = groupsById.get(groupId)!;
    const members = entitiesByGroup.get(groupId) ?? [];
    const visitedInGroup = members.filter((entity) => visitedAddresses.has(entity.address)).length;
    const activeEntity = members.find((entity) => entity.address === activeAddress);
    nodes.push({
      id: existing,
      line: 0,
      address: activeEntity?.address,
      title: group.label,
      detail: `${group.count} function${group.count === 1 ? '' : 's'}${visitedInGroup ? ` · ${visitedInGroup} visited` : ''}${activeEntity ? ` · selected: ${activeEntity.name}` : ''}`,
      kind: 'label',
      evidence: 'Compact program-flow namespace group.',
      reachable: true
    });
    labels.set(group.label, existing);
    actions.set(existing, { kind: 'group', groupId });
    return existing;
  };

  const ensureEntityNode = (entity: FlowEntity): string | null => {
    if (!includedGroups.has(entity.groupId)) return null;
    if (!expandedGroups.has(entity.groupId)) {
      const id = ensureGroupNode(entity.groupId);
      nodeIdByAddress.set(entity.address, id);
      return id;
    }
    const id = entityNodeId(fileId, entity);
    if (!nodes.some((node) => node.id === id)) {
      nodes.push({
        id,
        line: 0,
        address: entity.address,
        title: entity.name,
        detail: `0x${entity.address.toString(16)} · ${entity.detail}`,
        kind: 'call',
        evidence: entity.evidence,
        reachable: true
      });
      labels.set(entity.name, id);
      actions.set(id, entity.type === 'function'
        ? { kind: 'function', address: entity.address }
        : { kind: 'navigate', address: entity.address });
    }
    nodeIdByAddress.set(entity.address, id);
    return id;
  };

  if (scope === 'all') {
    for (const groupId of includedGroups) {
      if (expandedGroups.has(groupId)) {
        for (const entity of entitiesByGroup.get(groupId) ?? []) ensureEntityNode(entity);
      } else {
        ensureGroupNode(groupId);
      }
    }
  } else {
    for (const address of scopedAddresses) {
      const entity = entityByAddress.get(address);
      if (entity) ensureEntityNode(entity);
    }
  }

  const aggregated = new Map<string, { from: string; to: string; calls: number; branches: number }>();
  for (const transfer of transfers) {
    if (scope !== 'all' && (!scopedAddresses.has(transfer.fromAddress) || !scopedAddresses.has(transfer.toAddress))) continue;
    const sourceEntity = entityByAddress.get(transfer.fromAddress);
    const targetEntity = entityByAddress.get(transfer.toAddress);
    if (!sourceEntity || !targetEntity) continue;
    const from = ensureEntityNode(sourceEntity);
    const to = ensureEntityNode(targetEntity);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    const current = aggregated.get(key) ?? { from, to, calls: 0, branches: 0 };
    if (transfer.kind === 'call') current.calls += 1;
    else current.branches += 1;
    aggregated.set(key, current);
  }

  for (const [key, transfer] of aggregated) {
    const total = transfer.calls + transfer.branches;
    const edgeKind: GraphEdge['kind'] = transfer.calls > 0 && transfer.branches === 0 ? 'call' : 'branch';
    const label = transfer.calls && transfer.branches
      ? `${transfer.calls} call${transfer.calls === 1 ? '' : 's'} · ${transfer.branches} jump${transfer.branches === 1 ? '' : 's'}`
      : transfer.calls
        ? (total === 1 ? 'call' : `${total} calls`)
        : (total === 1 ? 'jump' : `${total} jumps`);
    edges.push({ id: `${fileId}:program-flow:edge:${key}`, from: transfer.from, to: transfer.to, kind: edgeKind, label });
  }

  const activeEntity = entityByAddress.get(activeAddress);
  if (activeEntity) ensureEntityNode(activeEntity);

  return {
    graph: {
      fileId,
      nodes,
      edges,
      labels,
      diagnostics: [`Program flow (${scope}): ${visitedAddresses.size} visited function(s), ${nodes.length} visible node(s), ${edges.length} visible interprocedural edge(s).`],
      sourceKind: 'raw-elf-capstone',
      architecture: 'x86-64',
      entryAddress: activeAddress,
      viewKind: 'program-flow',
      functionAddress: activeAddress,
      functionName: activeEntity?.name
    },
    groups,
    actions,
    visitedCount: visitedAddresses.size
  };
}
