import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, GitBranch, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { AnalysisGraph, GraphNode } from '../features/analysis/model';
import { layoutGraph, type PositionedGraphNode } from '../features/analysis/layout';
import type { ExecutionTraceProjection } from '../features/execution/follow';
import { EmptyState, IconButton } from './ui';

interface Viewport { x: number; y: number; zoom: number; }

const MIN_ZOOM = 0.22;
const MAX_ZOOM = 2.8;
const DEFAULT_VIEWPORT: Viewport = { x: 20, y: 10, zoom: 0.9 };
const CFG_MAX_VISIBLE_INSTRUCTIONS = 6;

const NODE_COLORS: Record<GraphNode['kind'], { fill: string; stroke: string }> = {
  label: { fill: '#0e1a25', stroke: '#355a74' },
  instruction: { fill: '#0d1721', stroke: '#3d596f' },
  branch: { fill: '#0d1721', stroke: '#52677a' },
  call: { fill: '#0f1720', stroke: '#655160' },
  syscall: { fill: '#11171f', stroke: '#74505a' },
  data: { fill: '#0d1918', stroke: '#3d6a5a' }
};

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function viewportForBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, width: number, height: number): Viewport {
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const padding = 42;
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
    minX = Math.min(minX, node.x - 24);
    minY = Math.min(minY, node.y - 24);
    maxX = Math.max(maxX, node.x + node.width + 24);
    maxY = Math.max(maxY, node.y + node.height + 24);
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

function drawCfgNode(
  ctx: CanvasRenderingContext2D,
  graph: AnalysisGraph,
  node: PositionedGraphNode,
  state: { selected: boolean; current: boolean; visited: boolean; executionCount: number }
) {
  const { selected, current, visited, executionCount } = state;
  const palette = NODE_COLORS[node.kind];
  const stroke = current ? '#169cff' : selected ? '#55b8ff' : visited ? '#2ac77b' : palette.stroke;

  ctx.globalAlpha = node.reachable === false ? 0.42 : 1;
  roundedRect(ctx, node.x, node.y, node.width, node.height, 7);
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = current ? 3 : selected ? 2.2 : visited ? 1.8 : 1.2;
  ctx.stroke();

  if (current || selected) {
    ctx.shadowColor = current ? '#0c8ee8' : '#247cb6';
    ctx.shadowBlur = current ? 18 : 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  if (current) {
    roundedRect(ctx, node.x, node.y, 4, node.height, 3);
    ctx.fillStyle = '#20a5ff';
    ctx.fill();
  }

  const headerBottom = node.y + 34;
  ctx.strokeStyle = '#1b2a35';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(node.x + 1, headerBottom);
  ctx.lineTo(node.x + node.width - 1, headerBottom);
  ctx.stroke();

  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = current ? '#70c8ff' : visited ? '#61d99a' : '#c6d4df';
  const address = node.address === undefined ? '—' : `0x${node.address.toString(16)}`;
  ctx.fillText(address, node.x + 12, node.y + 22);

  const headerLabel = cfgHeaderLabel(graph, node);
  if (headerLabel) {
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#8ea2b4';
    const label = fitText(ctx, headerLabel, node.width - 105);
    ctx.fillText(label, node.x + 94, node.y + 22);
  }

  const instructions = node.blockInstructions ?? [];
  const shown = instructions.slice(0, CFG_MAX_VISIBLE_INSTRUCTIONS);
  for (let index = 0; index < shown.length; index += 1) {
    const instruction = shown[index];
    const y = node.y + 54 + index * 17;
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = instruction.controlFlow === 'jump' ? '#d49a64' : instruction.controlFlow === 'call' ? '#61b8ee' : instruction.controlFlow === 'return' ? '#bb8fe0' : '#70bff0';
    ctx.fillText(instruction.mnemonic, node.x + 12, y);
    const mnemonicWidth = Math.max(54, ctx.measureText(instruction.mnemonic).width + 12);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#c1cfda';
    const operands = fitText(ctx, instruction.operands, node.width - mnemonicWidth - 24);
    ctx.fillText(operands, node.x + 12 + mnemonicWidth, y);
  }

  if (instructions.length > CFG_MAX_VISIBLE_INSTRUCTIONS) {
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#62788a';
    ctx.fillText(`… +${instructions.length - CFG_MAX_VISIBLE_INSTRUCTIONS} instruction${instructions.length - CFG_MAX_VISIBLE_INSTRUCTIONS === 1 ? '' : 's'}`, node.x + 12, node.y + node.height - 11);
  }

  if (executionCount > 0) {
    const badge = executionCount > 9999 ? '×9999+' : `×${executionCount}`;
    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    const badgeWidth = ctx.measureText(badge).width + 12;
    roundedRect(ctx, node.x + node.width - badgeWidth - 9, node.y + 9, badgeWidth, 17, 5);
    ctx.fillStyle = current ? '#0b4b72' : '#103929';
    ctx.fill();
    ctx.fillStyle = current ? '#8ed5ff' : '#80dfa8';
    ctx.fillText(badge, node.x + node.width - badgeWidth - 3, node.y + 21);
  }
  ctx.globalAlpha = 1;
}

function drawCompactNode(
  ctx: CanvasRenderingContext2D,
  node: PositionedGraphNode,
  state: { selected: boolean; current: boolean; visited: boolean; executionCount: number }
) {
  const { selected, current, visited, executionCount } = state;
  const palette = NODE_COLORS[node.kind];
  ctx.globalAlpha = node.reachable === false ? 0.42 : 1;
  roundedRect(ctx, node.x, node.y, node.width, node.height, 6);
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.strokeStyle = current ? '#169cff' : selected ? '#55b8ff' : visited ? '#2ac77b' : palette.stroke;
  ctx.lineWidth = current ? 3 : selected ? 2.2 : visited ? 1.8 : 1.2;
  ctx.stroke();
  if (current || selected) {
    ctx.shadowColor = '#0c8ee8';
    ctx.shadowBlur = current ? 16 : 9;
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
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [drag, setDrag] = useState<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const positioned = useMemo(() => graph ? layoutGraph(graph) : [], [graph]);
  const nodeById = useMemo(() => new Map(positioned.map((node) => [node.id, node])), [positioned]);

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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#080e13';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    if (grid) {
      ctx.strokeStyle = '#14202a';
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

    for (const edge of graph.edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const horizontalDataEdge = edge.kind === 'data' && Math.abs((to.x + to.width / 2) - (from.x + from.width / 2)) > 100;
      const x1 = horizontalDataEdge ? (to.x >= from.x ? from.x + from.width : from.x) : from.x + from.width / 2;
      const y1 = horizontalDataEdge ? from.y + from.height / 2 : from.y + from.height;
      const x2 = horizontalDataEdge ? (to.x >= from.x ? to.x : to.x + to.width) : to.x + to.width / 2;
      const y2 = horizontalDataEdge ? to.y + to.height / 2 : to.y;
      const traceCount = trace?.edgeCounts.get(edge.id) ?? 0;
      const conditional = conditionalSource(graph, edge.from);
      const trueBranch = conditional && edge.kind === 'branch';
      const falseBranch = conditional && edge.kind === 'control' && edge.label === 'fallthrough';
      const baseColor = trueBranch ? '#24c979' : falseBranch ? '#f05c64' : edge.kind === 'call' ? '#9270cf' : edge.kind === 'data' ? '#48ab8c' : '#6f8497';
      ctx.strokeStyle = traceCount ? '#2ca9ff' : baseColor;
      ctx.lineWidth = traceCount ? 3 : edge.kind === 'control' ? 1.5 : 1.8;
      ctx.beginPath();
      let labelX: number;
      let labelY: number;
      if (horizontalDataEdge) {
        const midX = (x1 + x2) / 2;
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(midX, y1, midX, y2, x2, y2);
        labelX = midX + 7;
        labelY = (y1 + y2) / 2 - 5;
      } else {
        const direction = x2 === x1 ? 0 : Math.sign(x2 - x1);
        const horizontalPull = Math.min(90, Math.abs(x2 - x1) * 0.36) * direction;
        const midY = y1 + Math.max(24, (y2 - y1) * 0.48);
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1 + horizontalPull, midY, x2 - horizontalPull, midY, x2, y2);
        labelX = (x1 + x2) / 2;
        labelY = midY - 8;
      }
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      if (horizontalDataEdge) {
        const direction = x2 >= x1 ? 1 : -1;
        ctx.moveTo(x2 - direction * 8, y2 - 5); ctx.lineTo(x2 - direction * 8, y2 + 5); ctx.lineTo(x2, y2); ctx.fill();
      } else {
        ctx.moveTo(x2 - 5, y2 - 9); ctx.lineTo(x2 + 5, y2 - 9); ctx.lineTo(x2, y2); ctx.fill();
      }

      if (labels && edge.label) {
        if (trueBranch) drawPill(ctx, `T · ${edge.label}`, labelX, labelY, '#0f3023', '#66e1a1', '#247a52');
        else if (falseBranch) drawPill(ctx, 'F · fallthrough', labelX, labelY, '#34171a', '#ff9196', '#874149');
        else {
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillStyle = traceCount ? '#83d4ff' : '#73889a';
          ctx.fillText(edge.label, labelX + 7, labelY - 1);
        }
      }
    }

    for (const node of positioned) {
      const selected = node.id === selectedId;
      const current = trace?.currentNodeId === node.id || (!!focusId && node.id === focusId);
      const executionCount = trace?.nodeCounts.get(node.id) ?? 0;
      const visited = executionCount > 0 && !current;
      const state = { selected, current, visited, executionCount };
      if (graph.viewKind === 'function-cfg' && node.blockInstructions?.length) drawCfgNode(ctx, graph, node, state);
      else drawCompactNode(ctx, node, state);
    }
    ctx.restore();
  }, [focusId, graph, grid, labels, measureHost, nodeById, positioned, selectedId, trace, viewport]);

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
    const bounds = boundsForNodes(positioned);
    if (!measured || !bounds) {
      setViewport(DEFAULT_VIEWPORT);
      return;
    }
    setViewport(viewportForBounds(bounds, measured.width, measured.height));
  }, [measureHost, positioned]);

  useEffect(() => {
    fitGraph();
  }, [fitGraph, graph?.fileId, graph?.functionAddress, graph?.viewKind, positioned.length]);

  useEffect(() => {
    const targetId = trace?.currentNodeId ?? focusId ?? selectedId;
    if (!targetId) return;
    const node = nodeById.get(targetId);
    const measured = measureHost();
    if (!node || !measured) return;
    setViewport((current) => centerViewport(node, measured.width, measured.height, Math.max(current.zoom, 0.72)));
  }, [focusId, measureHost, nodeById, selectedId, trace?.currentNodeId]);

  function screenToGraph(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom
    };
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

  return (
    <section className="graph-panel">
      <div className="graph-toolbar">
        <span><GitBranch size={14} /> {title}</span>
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
            const node = pickNode(event.clientX, event.clientY);
            if (node) { onSelect(node.id); return; }
            setDrag({ x: event.clientX, y: event.clientY, originX: viewport.x, originY: viewport.y });
          }}
          onDoubleClick={(event) => {
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
