import { useEffect, useState } from 'react';
import { Modal } from './ui';

export function PathOperationDialog({ title, description, initialValue, confirmLabel, onConfirm, onClose }: {
  title: string;
  description: string;
  initialValue: string;
  confirmLabel: string;
  onConfirm(value: string): void;
  onClose(): void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  const submit = () => {
    const clean = value.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!clean) return;
    onConfirm(clean);
  };
  return (
    <Modal title={title} onClose={onClose} width={540}>
      <div className="path-operation-dialog">
        <p>{description}</p>
        <label className="field-label" htmlFor="path-operation-value">Project path</label>
        <input id="path-operation-value" className="text-input" autoFocus value={value} onChange={(event) => setValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} />
        <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={submit}>{confirmLabel}</button></div>
      </div>
    </Modal>
  );
}
