import { useRef } from 'react';

export function ResizeHandle({ orientation, onDelta, className = '' }: {
  orientation: 'vertical' | 'horizontal';
  onDelta(delta: number): void;
  className?: string;
}) {
  const dragging = useRef(false);
  const previous = useRef(0);
  return (
    <div
      className={`resize-handle ${orientation} ${className}`}
      role="separator"
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      onPointerDown={(event) => {
        dragging.current = true;
        previous.current = orientation === 'vertical' ? event.clientX : event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const current = orientation === 'vertical' ? event.clientX : event.clientY;
        const delta = current - previous.current;
        previous.current = current;
        onDelta(delta);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { dragging.current = false; }}
    />
  );
}
