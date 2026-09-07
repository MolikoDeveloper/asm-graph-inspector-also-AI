import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Crosshair, GitBranch, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { AnalysisGraph, GraphEdge, GraphNode } from '../features/analysis/model';
import { isLoopLikeEdge, routeGraphEdge } from '../features/analysis/edgeRouting';
import { projectGraphSelection } from '../features/analysis/graphSelection';
import { layoutGraph, type PositionedGraphNode } from '../features/analysis/layout';
import type { ExecutionTraceProjection } from '../features/execution/follow';
import { EmptyState, IconButton } from './ui';

interface Viewport { x: number; y: number; zoom: number; }

interface MiniMapGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  plotX: number;
  plotY: number;
  scale: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface NodeVisualState {
  selected: boolean;
  current: boolean;
  visited: boolean;
  pathHighlighted: boolean;
  dimmed: boolean;
  executionCount: number;
}

const MIN_ZOOM = 0.22;
const MAX_ZOOM = 2.8;
const DEFAULT_VIEWPORT: Viewport = { x: 20, y: 10, zoom: 0.9 };
const CFG_MAX_VISIBLE_INSTRUCTIONS = 8;

const NODE_COLORS: Record<GraphNode['kind'], { fill: string; stroke: string }> = {
  label: { fill: '#0e1a25', stroke: '#355a74' },
  instruction: { fill: '#0c1720', stroke: '#38556b' },
  branch: { fill: '#0c1720', stroke: '#52677a' },
  call: { fill: '#0d1720', stroke: '#655160' },
  syscall: { fill: '#10171f', stroke: '#74505a' },
  data: { fill: '#0d1918', stroke: '#3d6a5a' }
};

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function viewportForBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, width: number, height: number): Viewport {
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const padding = 46;
  const availableWidth = Math.max(40, width - padding * 2);
  const availableHeight = Math.max(40, height - padding * 2);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availableWidth / contentWidth, availableHeight / contentHeight)));
  const offsetX = (width - contentWidth * zoom) * 0.5;
  const offsetY = (height - contentHeight * zoom) * 0.5;
  return {
    zoom,
    x: offsetX - bounds.minX * zoom,
    y: offsetY - bounds.minY * zoom
  };
}

function boundsForNodes(nodes: PositionedGraphNode[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!nodes.length) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - 30);
    minY = Math.min(minY, node.y - 30);
    maxX = Math.max(maxX, node.x + node.width + 30);
    maxY = Math.max(maxY, node.y + node.height + 30);
  }
  return { minX, minY, maxX, maxY };
}

function centerViewport(node: PositionedGraphNode, width: number, height: number, zoom: number): Viewport {
  return {
    zoom,
    x: width * 0.5 - (node.x + node.width * 0.5) * zoom,
    y: height * 0.5 - (node.y + node.height * 0.5) * zoom
  };
}

function fitText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

function drawPill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, background: string, foreground: string, border: string) {
  ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const width = ctx.measureText(text).width + 14;
  roundedRect(ctx, x - width / 2, y - 10, width, 20, 5);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = foreground;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function drawArrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, size = 8) {
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * size + px * size * 0.58, y - uy * size + py * size * 0.58);
  ctx.lineTo(x - ux * size - px * size * 0.58, y - uy * size - py * size * 0.58);
  ctx.closePath();
  ctx.fill();
}

function conditionalSource(graph: AnalysisGraph, nodeId: string): boolean {
  return graph.edges.some((edge) => edge.from === nodeId && edge.kind === 'branch')
    && graph.edges.some((edge) => edge.from === nodeId && edge.kind === 'control' && edge.label === 'fallthrough');
}

function cfgHeaderLabel(graph: AnalysisGraph, node: PositionedGraphNode): string {
  if (node.address === graph.functionAddress) return `<${graph.functionName ?? 'entry'}>`;
  const base = node.title.split(' · ')[0] ?? '';
  if (base.startsWith('block_')) return `B${base.slice('block_'.length)}`;
  return base === 'entry' ? '<entry>' : base;
}

function drawCfgNode(ctx: CanvasRenderingContext2D, graph: AnalysisGraph, node: PositionedGraphNode, state: NodeVisualState) {
  const { selected, current, visited, pathHighlighted, dimmed, executionCount } = state;
  const palette = NODE_COLORS[node.kind];
  const stroke = current
    ? '#179fff'
    : selected
      ? '#55b8ff'
      : visited
        ? '#2ac77b'
        : pathHighlighted
          ? '#3c91bb'
          : palette.stroke;

  const reachabilityAlpha = node.reachable === false ? 0.42 : 1;
  ctx.globalAlpha = dimmed ? Math.min(0.3, reachabilityAlpha) : reachabilityAlpha;
  ctx.shadowColor = 'rgba(0, 0, 0, .4)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  roundedRect(ctx, node.x, node.y, node.width, node.height, 8);
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = current ? 3 : selected ? 2.5 : visited ? 1.9 : pathHighlighted ? 1.8 : 1.2;
  ctx.stroke();

  if (current || selected) {
    ctx.shadowColor = current ? '#0c8ee8' : '#247cb6';
    ctx.shadowBlur = current ? 20 : 12;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  const accent = current ? '#20a5ff' : selected ? '#55b8ff' : visited ? '#2ac77b' : pathHighlighted ? '#3f98c0' : '#274154';
  roundedRect(ctx, node.x, node.y, 4, node.height, 3);
  ctx.fillStyle = accent;
  ctx.fill();

  const headerBottom = node.y + 37;
  ctx.fillStyle = '#0d1821';
  ctx.fillRect(node.x + 4, node.y + 1, node.width - 5, 35);
  ctx.strokeStyle = '#1d2c37';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(node.x + 5, headerBottom);
  ctx.lineTo(node.x + node.width - 1, headerBottom);
  ctx.stroke();

  ctx.font = '700 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = current ? '#78ceff' : visited ? '#68dca0' : '#d6e2eb';
  const address = node.address === undefined ? '—' : `0x${node.address.toString(16)}`;
  ctx.fillText(address, node.x + 14, node.y + 24);

  const headerLabel = cfgHeaderLabel(graph, node);
  if (headerLabel) {
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = node.address === graph.functionAddress ? '#b6c9d8' : '#8298aa';
    const label = fitText(ctx, headerLabel, node.width - 120);
    ctx.fillText(label, node.x + 110, node.y + 24);
  }

  const instructions = node.blockInstructions ?? [];
  const shown = instructions.slice(0, CFG_MAX_VISIBLE_INSTRUCTIONS);
  for (let index = 0; index < shown.length; index += 1) {
    const instruction = shown[index];
    const y = node.y + 57 + index * 18;
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = instruction.controlFlow === 'jump'
      ? '#e4a15e'
      : instruction.controlFlow === 'call'
        ? '#5fc5ff'
        : instruction.controlFlow === 'return'
          ? '#c99af0'
          : instruction.controlFlow === 'syscall'
            ? '#e98b98'
            : '#77bce7';
    ctx.fillText(instruction.mnemonic, node.x + 14, y);
    const mnemonicWidth = Math.max(62, ctx.measureText(instruction.mnemonic).width + 13);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#c8d4de';
    const operands = fitText(ctx, instruction.operands, node.width - mnemonicWidth - 30);
    ctx.fillText(operands, node.x + 14 + mnemonicWidth, y);
  }

  if (instructions.length > CFG_MAX_VISIBLE_INSTRUCTIONS) {
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#667d8f';
    ctx.fillText(`… +${instructions.length - CFG_MAX_VISIBLE_INSTRUCTIONS} instruction${instructions.length - CFG_MAX_VISIBLE_INSTRUCTIONS === 1 ? '' : 's'}`, node.x + 14, node.y + node.height - 12);
  }

  if (executionCount > 0) {
    const badge = executionCount > 9999 ? '×9999+' : `×${executionCount}`;
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    const badgeWidth = ctx.measureText(badge).width + 12;
    roundedRect(ctx, node.x + node.width - badgeWidth - 9, node.y + 10, badgeWidth, 17, 5);
    ctx.fillStyle = current ? '#0b4b72' : '#103929';
    ctx.fill();
    ctx.fillStyle = current ? '#8ed5ff' : '#80dfa8';
    ctx.fillText(badge, node.x + node.width - badgeWidth - 3, node.y + 22);
  }
  ctx.globalAlpha = 1;
}

function drawCompactNode(ctx: CanvasRenderingContext2D, node: PositionedGraphNode, state: NodeVisualState) {
  const { selected, current, visited, pathHighlighted, dimmed, executionCount } = state;
  const palette = NODE_COLORS[node.kind];
  ctx.globalAlpha = dimmed ? 0.28 : node.reachable === false ? 0.42 : 1;
  roundedRect(ctx, node.x, node.y, node.width, node.height, 7);
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.strokeStyle = current ? '#169cff' : selected ? '#55b8ff' : visited ? '#2ac77b' : pathHighlighted ? '#3c91bb' : palette.stroke;
  ctx.lineWidth = current ? 3 : selected ? 2.3 : visited ? 1.8 : pathHighlighted ? 1.7 : 1.2;
  ctx.stroke();
  if (current || selected) {
    ctx.shadowColor = '#0c8ee8';
    ctx.shadowBlur = current ? 16 : 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.fillStyle = '#d8e2ec';
  ctx.font = `${node.kind === 'label' ? 600 : 500} 12px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(fitText(ctx, node.title, node.width - 24), node.x + 12, node.y + 20);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#718698';
  ctx.fillText(fitText(ctx, node.detail, node.width - 24), node.x + 12, node.y + node.height - 9);
  if (executionCount > 0) {
    ctx.fillStyle = current ? '#83d5ff' : '#70d69d';
    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`×${executionCount}`, node.x + node.width - 38, node.y + 18);
  }
  ctx.globalAlpha = 1;
}

function structureColors(category: string | undefined): { fill: string; stroke: string; eyebrow: string; title: string } {
  const value = (category ?? '').toUpperCase();
  if (value.includes('BINARY ARTIFACT')) return { fill: '#0b2132', stroke: '#238fce', eyebrow: '#66c8ff', title: '#eef9ff' };
  if (value.includes('EXECUTABLE') || value.includes('ENTRY FUNCTION') || value.includes('ACTIVE FUNCTION') || value.includes('CODE')) return { fill: '#0d1e2b', stroke: '#2d87bb', eyebrow: '#5fb9e8', title: '#dceefa' };
  if (value.includes('WRITABLE')) return { fill: '#151c18', stroke: '#6c8d67', eyebrow: '#9bc78f', title: '#dcebd8' };
  if (value.includes('DEPENDENCY') || value.includes('INTERPRETER') || value.includes('DYNAMIC') || value.includes('LINK')) return { fill: '#171625', stroke: '#6c62a0', eyebrow: '#a59ae0', title: '#e5e0fb' };
  if (value.includes('UNRESOLVED') || value.includes('PERMISSION')) return { fill: '#231416', stroke: '#9a4e55', eyebrow: '#e38d93', title: '#f4dadd' };
  if (value.includes('SECTION') || value.includes('UNWIND') || value.includes('RELOCATION')) return { fill: '#0e1b1a', stroke: '#46796d', eyebrow: '#73b5a5', title: '#d8ece7' };
  if (value.includes('COLLAPSED')) return { fill: '#11161c', stroke: '#465462', eyebrow: '#778797', title: '#c2cdd6' };
  return { fill: '#101922', stroke: '#405c72', eyebrow: '#718ca1', title: '#d5e1ea' };
}

function drawStructureNode(ctx: CanvasRenderingContext2D, node: PositionedGraphNode, state: NodeVisualState) {
  const palette = structureColors(node.category);
  ctx.globalAlpha = state.dimmed ? 0.3 : 1;
  roundedRect(ctx, node.x, node.y, node.width, node.height, 8);
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.strokeStyle = state.selected ? '#39aaf2' : state.pathHighlighted ? '#3c91bb' : palette.stroke;
  ctx.lineWidth = state.selected ? 2.4 : state.pathHighlighted ? 1.8 : 1.25;
  ctx.stroke();
  if (state.selected) {
    ctx.shadowColor = '#178fd8';
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.font = '700 9px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = palette.eyebrow;
  ctx.fillText(fitText(ctx, (node.category ?? 'BINARY NODE').toUpperCase(), node.width - 24), node.x + 12, node.y + 16);

  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = palette.title;
  ctx.fillText(fitText(ctx, node.title, node.width - 24), node.x + 12, node.y + 34);

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#73899a';
  ctx.fillText(fitText(ctx, node.detail, node.width - 24), node.x + 12, node.y + node.height - 12);

  if (node.address !== undefined) {
    const address = `0x${node.address.toString(16)}`;
    ctx.font = '600 8px ui-monospace, SFMono-Regular, Menlo, monospace';
    const addressWidth = ctx.measureText(address).width + 10;
    roundedRect(ctx, node.x + node.width - addressWidth - 8, node.y + 7, addressWidth, 16, 5);
    ctx.fillStyle = '#0a1118';
    ctx.fill();
    ctx.fillStyle = '#8fb8d1';
    ctx.fillText(address, node.x + node.width - addressWidth - 3, node.y + 18);
  }
  ctx.globalAlpha = 1;
}

function edgeBaseColor(structural: boolean, trueBranch: boolean, falseBranch: boolean, edge: GraphEdge): string {
  if (structural) return edge.kind === 'call' ? '#625d8a' : edge.kind === 'data' ? '#3d6c64' : '#385c73';
  if (trueBranch) return '#24c979';
  if (falseBranch) return '#f05c64';
  if (edge.kind === 'call') return '#9270cf';
  if (edge.kind === 'data') return '#48ab8c';
  return '#6f8497';
}

function highlightedEdgeColor(trueBranch: boolean, falseBranch: boolean, edge: GraphEdge): string {
  if (trueBranch) return '#3ee394';
  if (falseBranch) return '#ff777f';
  if (edge.kind === 'call') return '#b49cff';
  if (edge.kind === 'data') return '#65d7b8';
  return '#5bc2ff';
}

function drawMiniMap(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  positioned: PositionedGraphNode[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewport: Viewport,
  selectedId: string | null,
  pathNodeIds: Set<string>
): MiniMapGeometry {
  const mapWidth = Math.max(132, Math.min(188, width * 0.23));
  const mapHeight = Math.max(92, Math.min(124, height * 0.24));
  const x = width - mapWidth - 13;
  const y = height - mapHeight - 13;
  const padding = 9;
  const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
  const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((mapWidth - padding * 2) / graphWidth, (mapHeight - padding * 2) / graphHeight);
  const plotWidth = graphWidth * scale;
  const plotHeight = graphHeight * scale;
  const plotX = x + (mapWidth - plotWidth) * 0.5;
  const plotY = y + (mapHeight - plotHeight) * 0.5;

  ctx.save();
  roundedRect(ctx, x, y, mapWidth, mapHeight, 7);
  ctx.fillStyle = 'rgba(8, 15, 21, .94)';
  ctx.fill();
  ctx.strokeStyle = '#29404f';
  ctx.lineWidth = 1;
  ctx.stroke();

  for (const node of positioned) {
    const nx = plotX + (node.x - bounds.minX) * scale;
    const ny = plotY + (node.y - bounds.minY) * scale;
    const nw = Math.max(2, node.width * scale);
    const nh = Math.max(2, node.height * scale);
    ctx.fillStyle = node.id === selectedId ? '#4eb6f2' : pathNodeIds.has(node.id) ? '#337da4' : '#263945';
    ctx.fillRect(nx, ny, nw, nh);
  }

  const viewportLeft = -viewport.x / viewport.zoom;
  const viewportTop = -viewport.y / viewport.zoom;
  const viewportRight = (width - viewport.x) / viewport.zoom;
  const viewportBottom = (height - viewport.y) / viewport.zoom;
  const vx = plotX + (viewportLeft - bounds.minX) * scale;
  const vy = plotY + (viewportTop - bounds.minY) * scale;
  const vw = Math.max(7, (viewportRight - viewportLeft) * scale);
  const vh = Math.max(7, (viewportBottom - viewportTop) * scale);
  ctx.strokeStyle = '#29a7f2';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(vx, vy, vw, vh);

  ctx.font = '700 7px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#5f7d91';
  ctx.fillText('MINIMAP', x + 7, y + 10);
  ctx.restore();

  return { x, y, width: mapWidth, height: mapHeight, plotX, plotY, scale, bounds };
}

export function GraphPanel({
  graph,
  title = 'Flow graph',
  grid,
  labels,
  selectedId,
  focusId = null,
  trace = null,
  onSelect,
  onActivate,
  onClear
}: {
  graph: AnalysisGraph | null;
  title?: string;
  grid: boolean;
  labels: boolean;
  selectedId: string | null;
  focusId?: string | null;
  trace?: ExecutionTraceProjection | null;
  onSelect(id: string | null): void;
  onActivate?(id: string): void;
  onClear?(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniMapRef = useRef<MiniMapGeometry | null>(null);
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [drag, setDrag] = useState<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const positioned = useMemo(() => graph ? layoutGraph(graph) : [], [graph]);
  const nodeById = useMemo(() => new Map(positioned.map((node) => [node.id, node])), [positioned]);
  const positionedBounds = useMemo(() => boundsForNodes(positioned), [positioned]);
  const selection = useMemo(() => projectGraphSelection(graph, selectedId), [graph, selectedId]);
  const selectionActive = Boolean(selectedId && selection.nodeIds.has(selectedId));

  const loopLaneById = useMemo(() => {
    const result = new Map<string, number>();
    if (!graph) return result;
    let lane = 0;
    for (const edge of graph.edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to || !isLoopLikeEdge(graph, edge, from, to)) continue;
      result.set(edge.id, lane);
      lane += 1;
    }
    return result;
  }, [graph, nodeById]);

  const measureHost = useCallback(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return null;
    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    return { width: rect.width, height: rect.height, dpr };
  }, []);

  const draw = useCallback(() => {
    const measured = measureHost();
    const canvas = canvasRef.current;
    if (!measured || !canvas || !graph) return;
    const { width, height, dpr } = measured;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const structural = graph.viewKind === 'binary-structure';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#080e13';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (grid) {
      ctx.strokeStyle = structural ? '#111f29' : '#14202a';
      ctx.lineWidth = 1 / viewport.zoom;
      const step = 24;
      const left = -viewport.x / viewport.zoom;
      const top = -viewport.y / viewport.zoom;
      const right = left + width / viewport.zoom;
      const bottom = top + height / viewport.zoom;
      ctx.beginPath();
      for (let x = Math.floor(left / step) * step; x < right; x += step) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
      for (let y = Math.floor(top / step) * step; y < bottom; y += step) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
      ctx.stroke();
    }

    const drawEdge = (edge: GraphEdge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) return;
      const route = routeGraphEdge({
        graph,
        edge,
        from,
        to,
        nodes: positioned,
        bounds: positionedBounds,
        loopLane: loopLaneById.get(edge.id),
        structural
      });
      const loop = route.loop;
      const traceCount = trace?.edgeCounts.get(edge.id) ?? 0;
      const conditional = !structural && conditionalSource(graph, edge.from);
      const trueBranch = conditional && edge.kind === 'branch';
      const falseBranch = conditional && edge.kind === 'control' && edge.label === 'fallthrough';
      const selectedPath = selection.edgeIds.has(edge.id);
      const dimmed = selectionActive && !selectedPath && traceCount === 0;
      const baseColor = edgeBaseColor(structural, trueBranch, falseBranch, edge);
      ctx.globalAlpha = dimmed ? 0.16 : 1;
      ctx.strokeStyle = traceCount ? '#2ca9ff' : selectedPath ? highlightedEdgeColor(trueBranch, falseBranch, edge) : baseColor;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = traceCount ? 3.2 : selectedPath ? 2.7 : structural ? 1.35 : edge.kind === 'control' ? 1.5 : 1.8;
      ctx.beginPath();

      const [first, ...rest] = route.points;
      if (!first) return;
      ctx.moveTo(first.x, first.y);
      for (const point of rest) ctx.lineTo(point.x, point.y);
      ctx.stroke();

      const arrow = route.points.at(-1)!;
      drawArrowHead(ctx, arrow.x, arrow.y, route.arrowDx, route.arrowDy, selectedPath || traceCount ? 9 : 8);

      if (labels && edge.label && !dimmed) {
        const loopSuffix = loop ? ' · loop' : '';
        const labelX = route.label.x;
        const labelY = route.label.y;
        if (trueBranch) drawPill(ctx, `T · ${edge.label}${loopSuffix}`, labelX, labelY, '#0f3023', '#66e1a1', '#247a52');
        else if (falseBranch) drawPill(ctx, `F · fallthrough${loopSuffix}`, labelX, labelY, '#34171a', '#ff9196', '#874149');
        else {
          ctx.font = `${structural ? 9 : 10}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.fillStyle = traceCount ? '#83d4ff' : selectedPath ? '#8fd7ff' : structural ? '#607b90' : '#73889a';
          const text = `${edge.label}${loopSuffix}`;
          ctx.fillText(text, labelX + 7, labelY - 5);
        }
      }
      ctx.globalAlpha = 1;
    };

    // Normal edges remain behind nodes. Semantic loop/back-edges are rendered after nodes on
    // dedicated obstacle-aware outer lanes so cycles stay visible without crossing sibling cards.
    for (const edge of graph.edges) if (!loopLaneById.has(edge.id)) drawEdge(edge);

    for (const node of positioned) {
      const selected = node.id === selectedId;
      const current = trace?.currentNodeId === node.id || (!!focusId && node.id === focusId);
      const executionCount = trace?.nodeCounts.get(node.id) ?? 0;
      const visited = executionCount > 0 && !current;
      const pathHighlighted = selection.nodeIds.has(node.id);
      const dimmed = selectionActive && !pathHighlighted && !current;
      const state = { selected, current, visited, pathHighlighted, dimmed, executionCount };
      if (structural) drawStructureNode(ctx, node, state);
      else if (graph.viewKind === 'function-cfg' && node.blockInstructions?.length) drawCfgNode(ctx, graph, node, state);
      else drawCompactNode(ctx, node, state);
    }

    for (const edge of graph.edges) if (loopLaneById.has(edge.id)) drawEdge(edge);
    ctx.restore();

    if (positionedBounds) {
      miniMapRef.current = drawMiniMap(ctx, width, height, positioned, positionedBounds, viewport, selectedId, selection.nodeIds);
    } else {
      miniMapRef.current = null;
    }
  }, [focusId, graph, grid, labels, loopLaneById, measureHost, nodeById, positioned, positionedBounds, selectedId, selection.edgeIds, selection.nodeIds, selectionActive, trace, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(host);
    draw();
    return () => observer.disconnect();
  }, [draw]);

  const fitGraph = useCallback(() => {
    const measured = measureHost();
    if (!measured || !positionedBounds) {
      setViewport(DEFAULT_VIEWPORT);
      return;
    }
    setViewport(viewportForBounds(positionedBounds, measured.width, measured.height));
  }, [measureHost, positionedBounds]);

  useEffect(() => {
    fitGraph();
  }, [fitGraph, graph?.fileId, graph?.functionAddress, graph?.viewKind, positioned.length]);

  useEffect(() => {
    // Selection is inspection only: never move/zoom the canvas on click. Runtime execution-follow may still
    // center the current RIP because that is an explicit debugger navigation event, not a selection side effect.
    const targetId = trace?.currentNodeId ?? focusId;
    if (!targetId) return;
    const node = nodeById.get(targetId);
    const measured = measureHost();
    if (!node || !measured) return;
    setViewport((current) => centerViewport(node, measured.width, measured.height, Math.max(current.zoom, 0.72)));
  }, [focusId, measureHost, nodeById, trace?.currentNodeId]);

  function screenToGraph(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom
    };
  }

  function screenPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top, width: rect.width, height: rect.height };
  }

  function pointInMiniMap(clientX: number, clientY: number): boolean {
    const mini = miniMapRef.current;
    if (!mini) return false;
    const point = screenPoint(clientX, clientY);
    return point.x >= mini.x && point.x <= mini.x + mini.width && point.y >= mini.y && point.y <= mini.y + mini.height;
  }

  function panFromMiniMap(clientX: number, clientY: number): boolean {
    const mini = miniMapRef.current;
    if (!mini) return false;
    const point = screenPoint(clientX, clientY);
    if (point.x < mini.x || point.x > mini.x + mini.width || point.y < mini.y || point.y > mini.y + mini.height) return false;
    const graphX = mini.bounds.minX + (point.x - mini.plotX) / mini.scale;
    const graphY = mini.bounds.minY + (point.y - mini.plotY) / mini.scale;
    setViewport((current) => ({
      ...current,
      x: point.width * 0.5 - graphX * current.zoom,
      y: point.height * 0.5 - graphY * current.zoom
    }));
    return true;
  }

  function pickNode(clientX: number, clientY: number) {
    const point = screenToGraph(clientX, clientY);
    for (let index = positioned.length - 1; index >= 0; index -= 1) {
      const node = positioned[index];
      if (point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height) return node;
    }
    return null;
  }

  if (!graph) {
    return <div className="graph-panel empty"><EmptyState icon={<GitBranch size={30} />} title="No graph yet" body="Open an ASM or binary file. Analysis starts automatically and commits only valid results." /></div>;
  }

  const ToolbarIcon = graph.viewKind === 'binary-structure' ? Boxes : GitBranch;
  return (
    <section className="graph-panel">
      <div className="graph-toolbar">
        <span><ToolbarIcon size={14} /> {title}</span>
        <div>
          <IconButton title="Zoom out" onClick={() => setViewport((value) => ({ ...value, zoom: Math.max(MIN_ZOOM, value.zoom - 0.1) }))}><Minus size={14} /></IconButton>
          <span className="zoom-value">{Math.round(viewport.zoom * 100)}%</span>
          <IconButton title="Zoom in" onClick={() => setViewport((value) => ({ ...value, zoom: Math.min(MAX_ZOOM, value.zoom + 0.1) }))}><Plus size={14} /></IconButton>
          <IconButton title="Fit graph" onClick={fitGraph}><Crosshair size={14} /></IconButton>
          <IconButton title="Reset selection" onClick={() => onSelect(null)}><RotateCcw size={14} /></IconButton>
          {onClear ? <IconButton title="Clear active graph" aria-label="Clear active graph" onClick={onClear}><Trash2 size={14} /></IconButton> : null}
        </div>
      </div>
      <div className="graph-canvas-wrap">
        <canvas
          ref={canvasRef}
          onWheel={(event) => {
            event.preventDefault();
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const screenX = event.clientX - rect.left;
            const screenY = event.clientY - rect.top;
            const factor = Math.exp(-event.deltaY * 0.0015);
            setViewport((value) => {
              const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value.zoom * factor));
              const graphX = (screenX - value.x) / value.zoom;
              const graphY = (screenY - value.y) / value.zoom;
              return {
                zoom: nextZoom,
                x: screenX - graphX * nextZoom,
                y: screenY - graphY * nextZoom
              };
            });
          }}
          onMouseDown={(event) => {
            if (panFromMiniMap(event.clientX, event.clientY)) return;
            const node = pickNode(event.clientX, event.clientY);
            if (node) { onSelect(node.id); return; }
            setDrag({ x: event.clientX, y: event.clientY, originX: viewport.x, originY: viewport.y });
          }}
          onDoubleClick={(event) => {
            if (pointInMiniMap(event.clientX, event.clientY)) return;
            const node = pickNode(event.clientX, event.clientY);
            if (!node) return;
            onSelect(node.id);
            onActivate?.(node.id);
          }}
          onMouseMove={(event) => {
            if (!drag) return;
            setViewport((value) => ({ ...value, x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y }));
          }}
          onMouseUp={() => setDrag(null)}
          onMouseLeave={() => setDrag(null)}
        />
      </div>
    </section>
  );
}
