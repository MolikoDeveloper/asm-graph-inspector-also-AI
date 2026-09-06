import { useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ProjectFile } from '../features/project/model';
import { inspectElfHeader } from '../features/binary/elfParser';

function hexPreview(bytes: ArrayBuffer | undefined, max = 4096): string {
  if (!bytes) return 'Binary bytes unavailable.';
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, max));
  const lines: string[] = [];
  for (let offset = 0; offset < view.length; offset += 16) {
    const chunk = view.slice(offset, offset + 16);
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`);
  }
  if (bytes.byteLength > max) lines.push(`\n… ${bytes.byteLength - max} more bytes`);
  return lines.join('\n');
}

export function SourceEditor({ file, fontSize, onChange, onFocus }: { file: ProjectFile; fontSize: number; onChange(text: string): void; onFocus(): void }) {
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const text = file.text ?? '';
  const binaryHeader = useMemo(() => file.kind === 'binary' ? inspectElfHeader(file.bytes) : null, [file.kind, file.bytes]);
  const lineNumbers = useMemo(() => Array.from({ length: Math.max(1, text.split(/\r?\n/).length) }, (_, index) => index + 1), [text]);

  if (file.kind === 'binary') {
    return (
      <div className="binary-viewer" onMouseDown={onFocus}>
        <div className="binary-summary"><strong>{file.name}</strong><span>{file.size.toLocaleString()} bytes</span>{binaryHeader?.valid ? <><span>{binaryHeader.kind}</span><span>{binaryHeader.architecture}</span><span>entry {binaryHeader.entry !== undefined ? `0x${binaryHeader.entry.toString(16)}` : '—'}</span></> : <span>read-only binary view</span>}</div>
        <pre>{hexPreview(file.bytes)}</pre>
      </div>
    );
  }

  function updateCursor(target: HTMLTextAreaElement) {
    const before = target.value.slice(0, target.selectionStart);
    const lines = before.split('\n');
    setCursor({ line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 });
  }

  return (
    <div className="source-editor" style={{ '--editor-font-size': `${fontSize}px` } as CSSProperties} onMouseDown={onFocus}>
      <div className="line-numbers" ref={lineNumbersRef}>{lineNumbers.map((line) => <span key={line}>{line}</span>)}</div>
      <textarea
        aria-label={`Editor for ${file.name}`}
        value={text}
        spellCheck={false}
        onChange={(event) => { onChange(event.target.value); updateCursor(event.target); }}
        onClick={(event) => updateCursor(event.currentTarget)}
        onKeyUp={(event) => updateCursor(event.currentTarget)}
        onScroll={(event) => { if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = event.currentTarget.scrollTop; }}
      />
      <div className="editor-position">Ln {cursor.line}, Col {cursor.column}</div>
    </div>
  );
}
