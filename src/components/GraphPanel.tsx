import { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, GitBranch, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { AnalysisGraph, GraphNode } from '../features/analysis/model';
import { layoutGraph } from '../features/analysis/layout';
import { EmptyState, IconButton } from './ui';

interface Viewport { x: number; y: number; zoom: number; }

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

export function GraphPanel({ graph, title = 'Flow graph', grid, labels, selectedId, onSelect, onClear }: { graph: AnalysisGraph | null; title?: string; grid: boolean; labels: boolean; selectedId: string | null; onSelect(id: string | null): void; onClear?(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 20, y: 10, zoom: 0.9 });
  const [drag, setDrag] = useState<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const positioned = useMemo(() => graph ? layoutGraph(graph) : [], [graph]);
  const nodeById = useMemo(() => new Map(positioned.map((node) => [node.id, node])), [positioned]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      draw();
    });
    observer.observe(host);
    return () => observer.disconnect();

    function draw() {
      if (!canvas || !graph) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
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
        ctx.strokeStyle = edge.kind === 'call' ? '#d06a72' : edge.kind === 'branch' ? '#7e6ad8' : edge.kind === 'data' ? '#43a88a' : '#3d79a8';
        ctx.lineWidth = edge.kind === 'control' ? 1.4 : edge.kind === 'data' ? 1.35 : 1.8;
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
        ctx.globalAlpha = node.reachable === false ? 0.42 : 1;
        roundedRect(ctx, node.x, node.y, node.width, node.height, 6);
        ctx.fillStyle = palette.fill;
        ctx.fill();
        ctx.strokeStyle = selected ? '#67b9ff' : palette.stroke;
        ctx.lineWidth = selected ? 2.4 : 1.25;
        ctx.stroke();
        if (selected) {
          ctx.shadowColor = '#2d8bd8';
          ctx.shadowBlur = 16;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
        ctx.fillStyle = '#d8e2ec';
        ctx.font = `${node.kind === 'label' ? 600 : 500} 13px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const title = node.title.length > 31 ? `${node.title.slice(0, 30)}…` : node.title;
        ctx.fillText(title, node.x + 12, node.y + 22);
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = '#74869a';
        ctx.fillText(node.detail, node.x + 12, node.y + node.height - 10);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
  }, [graph, grid, labels, nodeById, positioned, selectedId, viewport]);

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
          <IconButton title="Zoom out" onClick={() => setViewport((value) => ({ ...value, zoom: Math.max(0.22, value.zoom - 0.1) }))}><Minus size={14} /></IconButton>
          <span className="zoom-value">{Math.round(viewport.zoom * 100)}%</span>
          <IconButton title="Zoom in" onClick={() => setViewport((value) => ({ ...value, zoom: Math.min(2.8, value.zoom + 0.1) }))}><Plus size={14} /></IconButton>
          <IconButton title="Fit graph" onClick={() => setViewport({ x: 20, y: 10, zoom: 0.9 })}><Crosshair size={14} /></IconButton>
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
              const nextZoom = Math.min(2.8, Math.max(0.22, value.zoom * factor));
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
