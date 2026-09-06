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

const NODE_COLORS: Record<GraphNode['kind'], { fill: string; stroke: string }> = {
  label: { fill: '#101d2a', stroke: '#2f88c9' },
  instruction: { fill: '#111a24', stroke: '#45627c' },
  branch: { fill: '#181629', stroke: '#7e6ad8' },
  call: { fill: '#23171a', stroke: '#d06a72' },
  syscall: { fill: '#29171b', stroke: '#ec6974' },
  data: { fill: '#10241d', stroke: '#4bb889' }
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
    ctx.fillStyle = '#0a0f14';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    if (grid) {
      ctx.strokeStyle = '#18222d';
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
      ctx.strokeStyle = traceCount ? '#c9a84d' : edge.kind === 'call' ? '#d06a72' : edge.kind === 'branch' ? '#7e6ad8' : edge.kind === 'data' ? '#43a88a' : '#3d79a8';
      ctx.lineWidth = traceCount ? 2.8 : edge.kind === 'control' ? 1.4 : edge.kind === 'data' ? 1.35 : 1.8;
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
        const midY = y1 + Math.max(18, (y2 - y1) * 0.5);
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
        labelX = (x1 + x2) / 2 + 7;
        labelY = midY - 5;
      }
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      if (horizontalDataEdge) {
        const direction = x2 >= x1 ? 1 : -1;
        ctx.moveTo(x2 - direction * 8, y2 - 5); ctx.lineTo(x2 - direction * 8, y2 + 5); ctx.lineTo(x2, y2); ctx.fill();
      } else {
        ctx.moveTo(x2 - 5, y2 - 8); ctx.lineTo(x2 + 5, y2 - 8); ctx.lineTo(x2, y2); ctx.fill();
      }
      if (labels && edge.label) {
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = '#8193a6';
        ctx.fillText(edge.label, labelX, labelY);
      }
    }

    for (const node of positioned) {
      const palette = NODE_COLORS[node.kind];
      const selected = node.id === selectedId;
      const focused = !!focusId && node.id === focusId;
      const current = trace?.currentNodeId === node.id;
      const executionCount = trace?.nodeCounts.get(node.id) ?? 0;
      ctx.globalAlpha = node.reachable === false ? 0.42 : 1;
      roundedRect(ctx, node.x, node.y, node.width, node.height, 6);
      ctx.fillStyle = palette.fill;
      ctx.fill();
      ctx.strokeStyle = current ? '#ffd866' : selected ? '#67b9ff' : focused ? '#f8d66d' : executionCount ? '#b99b47' : palette.stroke;
      ctx.lineWidth = current ? 3 : selected ? 2.4 : focused || executionCount ? 2 : 1.25;
      ctx.stroke();
      if (selected || focused || current) {
        ctx.shadowColor = current ? '#d3aa31' : selected ? '#2d8bd8' : '#b78a1f';
        ctx.shadowBlur = current ? 20 : selected ? 16 : 12;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      if (focused || current) {
        ctx.fillStyle = current ? '#ffd866' : '#f8d66d';
        ctx.beginPath();
        ctx.arc(node.x + node.width - 12, node.y + 12, 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#d8e2ec';
      ctx.font = `${node.kind === 'label' ? 600 : 500} 13px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const title = node.title.length > 31 ? `${node.title.slice(0, 30)}…` : node.title;
      ctx.fillText(title, node.x + 12, node.y + 22);
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = '#74869a';
      ctx.fillText(node.detail, node.x + 12, node.y + node.height - 10);
      if (executionCount > 0) {
        const badge = executionCount > 9999 ? '9999+' : `×${executionCount}`;
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const badgeWidth = ctx.measureText(badge).width + 10;
        roundedRect(ctx, node.x + node.width - badgeWidth - 8, node.y + node.height - 22, badgeWidth, 16, 4);
        ctx.fillStyle = current ? '#5c4811' : '#342d1b';
        ctx.fill();
        ctx.fillStyle = current ? '#ffe69a' : '#d8bd72';
        ctx.fillText(badge, node.x + node.width - badgeWidth - 3, node.y + node.height - 10);
      }
      ctx.globalAlpha = 1;
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
    setViewport((current) => centerViewport(node, measured.width, measured.height, current.zoom));
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
