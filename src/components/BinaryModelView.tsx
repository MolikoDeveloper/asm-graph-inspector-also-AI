import { Boxes, Braces, GitFork, Grid2X2, MemoryStick } from 'lucide-react';
import type { BinaryAnalysisSummary, ElfCfiRow } from '../features/binary/model';
import { formatCfiRow } from '../features/binary/unwind';

export type BinaryModelViewKind = 'map' | 'sections' | 'symbols' | 'relocs' | 'unwind';

function hex(value: number): string { return `0x${value.toString(16)}`; }
function flags(readable: boolean, writable: boolean, executable: boolean): string { return `${readable ? 'R' : '-'}${writable ? 'W' : '-'}${executable ? 'X' : '-'}`; }

function EmptyTable({ children }: { children: string }) {
  return <div className="binary-empty">{children}</div>;
}

function CfiPreview({ row }: { row: ElfCfiRow | null }) {
  return <span className="binary-cfi-preview">{row ? formatCfiRow(row) : 'no decoded CFI row'}</span>;
}

export function BinaryModelView({ summary, view, onNavigate }: { summary: BinaryAnalysisSummary; view: BinaryModelViewKind; onNavigate?(address: number): void }) {
  const image = summary.image;
  if (view === 'map') {
    return (
      <div className="binary-model-view">
        <div className="binary-view-heading"><Grid2X2 size={15} /><div><strong>Binary map</strong><span>{image.kind} · {image.architecture} · entry {hex(image.entry)}</span></div></div>
        <div className="binary-facts">
          <span><b>Build ID</b>{image.buildId ?? '—'}</span>
          <span><b>Interpreter</b>{image.interpreter ?? '—'}</span>
          <span><b>SONAME</b>{image.soname ?? '—'}</span>
          <span><b>Dependencies</b>{image.neededLibraries.join(', ') || '—'}</span>
        </div>
        {summary.dependencies.length ? <div className="binary-dependency-list">{summary.dependencies.map((dependency) => <div className={`binary-dependency-row ${dependency.status}`} key={dependency.requestedName}><span className="binary-dependency-status">{dependency.status === 'resolved' ? 'resolved' : dependency.status === 'permission-required' ? 'permission' : 'unresolved'}</span><strong>{dependency.requestedName}</strong><small>{dependency.status === 'resolved' ? `via ${dependency.sourceName ?? dependency.fileName ?? 'global dependency'}` : dependency.evidence}</small></div>)}</div> : null}
        <div className="binary-map-list">
          {image.segments.map((segment) => (
            <button type="button" className="binary-map-row binary-navigate-row" key={segment.index} onClick={() => onNavigate?.(segment.virtualAddress)} title={`Reveal ${hex(segment.virtualAddress)} in disassembly`}>
              <div className="binary-map-label"><strong>PT_LOAD #{segment.index}</strong><code>{flags(segment.readable, segment.writable, segment.executable)}</code></div>
              <div className="binary-map-range"><span>{hex(segment.virtualAddress)}</span><i /><span>{hex(segment.virtualAddress + segment.memorySize)}</span></div>
              <small>file +{hex(segment.offset)} · {segment.fileSize} B file · {segment.memorySize} B memory</small>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (view === 'sections') {
    return (
      <div className="binary-model-view">
        <div className="binary-view-heading"><Boxes size={15} /><div><strong>Sections</strong><span>{image.sections.length} raw ELF section headers · click an allocated section to reveal it</span></div></div>
        {image.sections.length ? <div className="binary-table-wrap"><table className="binary-table"><thead><tr><th>#</th><th>Name</th><th>Address</th><th>Offset</th><th>Size</th><th>Flags</th><th>Type</th></tr></thead><tbody>{image.sections.map((section) => <tr className={section.allocated && section.size ? 'binary-table-navigate' : ''} key={section.index} onClick={() => { if (section.allocated && section.size) onNavigate?.(section.address); }}><td>{section.index}</td><td>{section.name || '—'}</td><td>{hex(section.address)}</td><td>{hex(section.offset)}</td><td>{section.size}</td><td>{flags(section.allocated, section.writable, section.executable)}</td><td>{hex(section.type)}</td></tr>)}</tbody></table></div> : <EmptyTable>No ELF sections.</EmptyTable>}
      </div>
    );
  }

  if (view === 'symbols') {
    return (
      <div className="binary-model-view">
        <div className="binary-view-heading"><Braces size={15} /><div><strong>Symbols</strong><span>{image.symbols.length} entries from raw ELF symbol tables · click a defined symbol to reveal it</span></div></div>
        {image.symbols.length ? <div className="binary-table-wrap"><table className="binary-table"><thead><tr><th>Name</th><th>Address</th><th>Size</th><th>Bind</th><th>Type</th><th>Section</th></tr></thead><tbody>{image.symbols.slice(0, 2500).map((symbol) => <tr className={symbol.defined ? 'binary-table-navigate' : ''} key={`${symbol.tableSectionIndex}:${symbol.index}`} onClick={() => { if (symbol.defined) onNavigate?.(symbol.value); }}><td>{symbol.name || '—'}</td><td>{hex(symbol.value)}</td><td>{symbol.size}</td><td>{symbol.binding}</td><td>{symbol.type}{symbol.functionLike ? ' · FUNC' : ''}</td><td>{symbol.defined ? symbol.sectionIndex : 'UND'}</td></tr>)}</tbody></table>{image.symbols.length > 2500 ? <div className="binary-row-limit">Showing first 2,500 symbols. Virtualized large-list view is still pending.</div> : null}</div> : <EmptyTable>No symbols in this ELF.</EmptyTable>}
      </div>
    );
  }

  if (view === 'relocs') {
    return (
      <div className="binary-model-view">
        <div className="binary-view-heading"><GitFork size={15} /><div><strong>Relocations</strong><span>{image.relocations.length} raw REL/RELA entries · {summary.pltStubs.length} proven PLT linkage stubs</span></div></div>
        {image.relocations.length ? <div className="binary-table-wrap"><table className="binary-table"><thead><tr><th>Offset</th><th>Type</th><th>Symbol</th><th>Addend</th><th>Section</th></tr></thead><tbody>{image.relocations.map((relocation, index) => <tr className="binary-table-navigate" key={`${relocation.sectionIndex}:${relocation.offset}:${index}`} onClick={() => onNavigate?.(relocation.offset)}><td>{hex(relocation.offset)}</td><td>{relocation.type}</td><td>{relocation.symbolName || '—'}</td><td>{relocation.addend === null ? '—' : relocation.addend}</td><td>{relocation.sectionName}</td></tr>)}</tbody></table></div> : <EmptyTable>No ELF relocations.</EmptyTable>}
      </div>
    );
  }

  return (
    <div className="binary-model-view">
      <div className="binary-view-heading"><MemoryStick size={15} /><div><strong>Unwind / CFI</strong><span>{image.unwind.cies.length} CIE · {image.unwind.fdes.length} preferred FDE · {image.unwind.cfiRowCount} decoded CFI rows · click an FDE to reveal it</span></div></div>
      {image.unwind.fdes.length ? <div className="unwind-list">{image.unwind.fdes.map((fde) => <button type="button" className="unwind-row binary-navigate-row" key={fde.id} onClick={() => onNavigate?.(fde.startAddress)}><div><strong>{fde.source}</strong><code>{hex(fde.startAddress)}..{hex(fde.endAddress)}</code><span>{fde.unwindRows.length} rows</span></div><CfiPreview row={fde.unwindRows[0] ?? null} />{fde.cfiDiagnostics.length ? <small>{fde.cfiDiagnostics.length} CFI diagnostic(s)</small> : null}</button>)}</div> : <EmptyTable>No `.eh_frame` / `.debug_frame` FDE coverage.</EmptyTable>}
      {image.unwind.cfiDiagnostics.length || image.unwind.errors.length ? <div className="unwind-diagnostics"><strong>Diagnostics</strong>{[...image.unwind.errors, ...image.unwind.cfiDiagnostics].slice(0, 100).map((diagnostic, index) => <span key={index}>{diagnostic}</span>)}</div> : null}
    </div>
  );
}
