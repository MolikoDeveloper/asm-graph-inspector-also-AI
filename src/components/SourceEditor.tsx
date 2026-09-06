import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ProjectFile } from '../features/project/model';
import type { EditorRevealTarget } from '../features/workspace/model';
import type { AssemblyProblem } from '../features/analysis/asmParser';
import { inspectElfHeader } from '../features/binary/elfParser';
import { loadFullBinaryDisassembly, type BinaryDisassemblyDocument } from '../features/analysis/binaryDisassembly';
import { HighlightedAssemblyLine } from './AssemblySyntax';

function hexPreview(bytes: ArrayBuffer | undefined, max = 64 * 1024): string {
  if (!bytes) return 'Binary bytes unavailable.';
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, max));
  const lines: string[] = [];
  for (let offset = 0; offset < view.length; offset += 16) {
    const chunk = view.slice(offset, offset + 16);
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map((byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`);
  }
  if (bytes.byteLength > max) lines.push(`\n… ${bytes.byteLength - max} more bytes (use Disassembly for the complete executable code view)`);
  return lines.join('\n');
}

function findAddressIndex(document: BinaryDisassemblyDocument, address: number): number {
  let low = 0;
  let high = document.lines.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const line = document.lines[mid];
    if (address >= line.address && address < line.endAddress) return mid;
    if (line.address < address) { best = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return best;
}

function BinaryDisassemblyEditor({ file, fontSize, revealTarget, onFocus }: {
  file: ProjectFile;
  fontSize: number;
  revealTarget: EditorRevealTarget | null;
  onFocus(): void;
}) {
  const [mode, setMode] = useState<'disassembly' | 'hex'>('disassembly');
  const [document, setDocument] = useState<BinaryDisassemblyDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);
  const binaryHeader = useMemo(() => inspectElfHeader(file.bytes), [file.bytes]);
  const rowHeight = Math.max(19, Math.round(fontSize * 1.65));

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setError(null);
    setProgress({ completed: 0, total: 0 });
    void loadFullBinaryDisassembly(file, (completed, total) => {
      if (!cancelled) setProgress({ completed, total });
    }).then((result) => {
      if (!cancelled) setDocument(result);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [file.id, file.updatedAt, file]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    if (!document || revealTarget?.fileId !== file.id || revealTarget.address === undefined || !scrollRef.current) return;
    const index = findAddressIndex(document, revealTarget.address);
    const targetTop = Math.max(0, index * rowHeight - scrollRef.current.clientHeight * 0.32);
    scrollRef.current.scrollTop = targetTop;
    setScrollTop(targetTop);
    setMode('disassembly');
  }, [document, file.id, revealTarget?.nonce, revealTarget?.address, revealTarget?.fileId, rowHeight]);

  const start = document ? Math.max(0, Math.floor(scrollTop / rowHeight) - 24) : 0;
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 48;
  const end = document ? Math.min(document.lines.length, start + visibleCount) : 0;
  const visible = document?.lines.slice(start, end) ?? [];
  const progressPercent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <div className="binary-editor" onMouseDown={onFocus} style={{ '--editor-font-size': `${fontSize}px`, '--disassembly-row-height': `${rowHeight}px` } as CSSProperties}>
      <div className="binary-summary">
        <strong>{file.name}</strong><span>{file.size.toLocaleString()} bytes</span>
        {binaryHeader?.valid ? <><span>{binaryHeader.kind}</span><span>{binaryHeader.architecture}</span><span>entry {binaryHeader.entry !== undefined ? `0x${binaryHeader.entry.toString(16)}` : '—'}</span></> : <span>binary</span>}
        <div className="binary-editor-modes"><button className={mode === 'disassembly' ? 'active' : ''} onClick={() => setMode('disassembly')}>Disassembly</button><button className={mode === 'hex' ? 'active' : ''} onClick={() => setMode('hex')}>Hex</button></div>
      </div>
      {mode === 'hex' ? <pre className="binary-hex-view">{hexPreview(file.bytes)}</pre> : (
        <div className="disassembly-surface">
          {!document && !error ? <div className="disassembly-loading"><strong>Decoding complete executable ASM…</strong><span>{progress.total ? `${progressPercent}% · ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} bytes` : 'Preparing raw ELF + Capstone…'}</span><i><b style={{ width: `${progressPercent}%` }} /></i></div> : null}
          {error ? <div className="disassembly-error"><strong>Disassembly failed</strong><span>{error}</span></div> : null}
          {document ? (
            <>
              <div className="disassembly-meta"><span>{document.lines.length.toLocaleString()} instructions</span><span>{document.sectionCount} executable sections</span><span>{document.decodedBytes.toLocaleString()} decoded bytes</span>{document.skippedBytes ? <span>{document.skippedBytes.toLocaleString()} undecodable/padding bytes skipped</span> : null}</div>
              <div ref={scrollRef} className="disassembly-scroll" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
                <div className="disassembly-spacer" style={{ height: document.lines.length * rowHeight }}>
                  <div className="disassembly-window" style={{ transform: `translateY(${start * rowHeight}px)` }}>
                    {visible.map((line) => {
                      const selected = revealTarget?.fileId === file.id && revealTarget.address !== undefined && revealTarget.address >= line.address && revealTarget.address < line.endAddress;
                      return (
                        <div key={line.address} className={selected ? 'disassembly-row selected' : 'disassembly-row'} style={{ height: rowHeight }}>
                          <code className="disassembly-address">{line.address.toString(16).padStart(16, '0')}</code>
                          <code className="disassembly-bytes">{line.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}</code>
                          <code className="disassembly-code"><HighlightedAssemblyLine line={`${line.mnemonic}${line.operands ? ` ${line.operands}` : ''}`} /></code>
                          <span className="disassembly-symbol">{line.symbolName ? `${line.symbolName}:` : ''}</span>
                          <span className="disassembly-section">{line.sectionName}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function SourceEditor({ file, fontSize, onChange, onFocus, revealTarget, problems = [] }: {
  file: ProjectFile;
  fontSize: number;
  onChange(text: string): void;
  onFocus(): void;
  revealTarget: EditorRevealTarget | null;
  problems?: AssemblyProblem[];
}) {
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const text = file.text ?? '';
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const errorLines = useMemo(() => new Set(problems.filter((problem) => problem.severity === 'error').map((problem) => problem.line)), [problems]);

  useEffect(() => {
    if (file.kind === 'binary' || revealTarget?.fileId !== file.id || !revealTarget.line || !textareaRef.current) return;
    const line = Math.max(1, Math.min(lines.length, revealTarget.line));
    let start = 0;
    for (let index = 1; index < line; index += 1) start += lines[index - 1].length + 1;
    const textarea = textareaRef.current;
    textarea.setSelectionRange(start, start);
    const lineHeight = fontSize * 1.55;
    textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - textarea.clientHeight * 0.32);
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = textarea.scrollTop;
    if (highlightRef.current) highlightRef.current.scrollTop = textarea.scrollTop;
    setCursor({ line, column: 1 });
  }, [file.id, file.kind, revealTarget?.nonce, revealTarget?.fileId, revealTarget?.line, lines, fontSize]);

  if (file.kind === 'binary') return <BinaryDisassemblyEditor file={file} fontSize={fontSize} revealTarget={revealTarget} onFocus={onFocus} />;

  function updateCursor(target: HTMLTextAreaElement) {
    const before = target.value.slice(0, target.selectionStart);
    const beforeLines = before.split('\n');
    setCursor({ line: beforeLines.length, column: (beforeLines.at(-1)?.length ?? 0) + 1 });
  }

  function syncScroll(target: HTMLTextAreaElement) {
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = target.scrollTop;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = target.scrollTop;
      highlightRef.current.scrollLeft = target.scrollLeft;
    }
  }

  return (
    <div className="source-editor" style={{ '--editor-font-size': `${fontSize}px` } as CSSProperties} onMouseDown={onFocus}>
      <div className="line-numbers" ref={lineNumbersRef}>{lines.map((_, index) => <span key={index + 1} className={errorLines.has(index + 1) ? 'problem' : ''}>{index + 1}</span>)}</div>
      <div className="source-code-layer">
        <pre ref={highlightRef} aria-hidden="true" className="syntax-highlight-layer">{lines.map((line, index) => <span className={errorLines.has(index + 1) ? 'syntax-line problem' : 'syntax-line'} key={index}><HighlightedAssemblyLine line={line} />{index < lines.length - 1 ? '\n' : ''}</span>)}</pre>
        <textarea
          ref={textareaRef}
          aria-label={`Editor for ${file.name}`}
          value={text}
          spellCheck={false}
          onChange={(event) => { onChange(event.target.value); updateCursor(event.target); }}
          onClick={(event) => updateCursor(event.currentTarget)}
          onKeyUp={(event) => updateCursor(event.currentTarget)}
          onScroll={(event) => syncScroll(event.currentTarget)}
        />
      </div>
      <div className="editor-position">Ln {cursor.line}, Col {cursor.column}{problems.length ? ` · ${problems.length} problem${problems.length === 1 ? '' : 's'}` : ''}</div>
    </div>
  );
}
