import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  action(): void;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const width = 220;
  const left = Math.min(x, Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(y, Math.max(8, window.innerHeight - Math.min(360, items.length * 32 + 16) - 8));
  return (
    <div ref={ref} className="context-menu" style={{ left, top }} onPointerDown={(event) => event.stopPropagation()}>
      {items.map((item, index) => (
        <div key={`${item.label}:${index}`}>
          {item.separatorBefore ? <div className="context-menu-separator" /> : null}
          <button className={item.danger ? 'danger' : ''} disabled={item.disabled} onClick={() => { item.action(); onClose(); }}>{item.label}</button>
        </div>
      ))}
    </div>
  );
}
