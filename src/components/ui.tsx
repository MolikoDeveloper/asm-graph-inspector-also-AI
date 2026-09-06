import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { X } from 'lucide-react';

export function IconButton({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`icon-button ${className}`} {...props}>{children}</button>;
}

export function Modal({ title, children, onClose, width = 720 }: PropsWithChildren<{ title: string; onClose?: () => void; width?: number }>) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-shell" role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, calc(100vw - 48px))` }}>
        <header className="modal-header">
          <h2>{title}</h2>
          {onClose ? <IconButton aria-label="Close" onClick={onClose}><X size={18} /></IconButton> : null}
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <strong>{title}</strong>
      <p>{body}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
