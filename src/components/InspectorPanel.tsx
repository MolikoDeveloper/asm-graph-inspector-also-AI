import { Binary, Braces, GitBranch, GitFork, MemoryStick } from 'lucide-react';
import type { AnalysisGraph } from '../features/analysis/model';
import type { CanonicalOperand } from '../features/binary/model';

function formatOperand(operand: CanonicalOperand): string {
  const access = `${operand.access.read ? 'R' : ''}${operand.access.write ? 'W' : ''}` || '—';
  if (operand.kind === 'register') return `#${operand.index} reg ${operand.register ?? '—'} · ${operand.size} B · ${access}`;
  if (operand.kind === 'immediate') return `#${operand.index} imm ${String(operand.value)} · ${operand.size} B`;
  if (operand.kind === 'floating') return `#${operand.index} fp ${operand.value} · ${operand.size} B`;
  if (operand.kind === 'memory') {
    const memory = operand.memory;
    const address = [
      memory.base,
      memory.index ? `${memory.index}${memory.scale !== 1 ? `*${memory.scale}` : ''}` : null,
      memory.displacement !== 0 ? String(memory.displacement) : null
    ].filter(Boolean).join(' + ') || 'absolute';
    return `#${operand.index} mem [${address}] · ${memory.width} B · ${access}`;
  }
  return `#${operand.index} other · ${operand.size} B · ${access}`;
}

export function InspectorPanel({ graph, selectedId, stale = false, onNavigate }: { graph: AnalysisGraph | null; selectedId: string | null; stale?: boolean; onNavigate?(target: { line?: number; address?: number }): void }) {
  const node = selectedId && graph ? graph.nodes.find((candidate) => candidate.id === selectedId) ?? null : null;
  return (
    <aside className="inspector-panel">
      <div className="inspector-tabs"><button className="active">Properties</button></div>
      {node ? (
        <div className="inspector-content">
          {stale ? <div className="inspector-stale-notice">Current ASM has problems. Showing the last valid analysis snapshot.</div> : null}
          <span className="inspector-eyebrow">{node.kind}</span>
          <h3>{node.title}</h3>
          <dl className="property-list">
            <div><dt>Line</dt><dd>{node.line || '—'}</dd></div>
            <div><dt>Kind</dt><dd>{node.kind}</dd></div>
            <div><dt>Address</dt><dd>{node.address !== undefined ? `0x${node.address.toString(16)}` : 'source-only'}</dd></div>
            {node.bytes?.length ? <div><dt>Bytes</dt><dd>{node.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}</dd></div> : null}
          </dl>
          <section className="inspector-section"><h4><GitFork size={14} /> Connections</h4><p>{graph?.edges.filter((edge) => edge.from === node.id || edge.to === node.id).length ?? 0} graph edges touch this node.</p></section>
          <section className="inspector-section"><h4><Braces size={14} /> Evidence</h4><p>{node.evidence ?? (graph?.sourceKind === 'raw-elf-capstone' ? 'Raw ELF bytes + canonical Capstone decode.' : 'Assembly parser · active source file.')}</p></section>
          {node.registerReads?.length || node.registerWrites?.length ? (
            <section className="inspector-section"><h4><Binary size={14} /> Register access</h4><p>reads: {node.registerReads?.join(', ') || '—'}<br />writes: {node.registerWrites?.join(', ') || '—'}</p></section>
          ) : null}
          {node.operandDetails?.length ? (
            <section className="inspector-section">
              <h4><MemoryStick size={14} /> Canonical operands</h4>
              <p className="operand-lines">{node.operandDetails.map((operand) => formatOperand(operand)).join('\n')}</p>
            </section>
          ) : null}
          {node.blockInstructions?.length ? (
            <section className="inspector-section">
              <h4><GitBranch size={14} /> Basic block</h4>
              <div className="inspector-instruction-list">{node.blockInstructions.map((instruction) => <button key={instruction.address} onClick={() => onNavigate?.({ address: instruction.address })}><code>0x{instruction.address.toString(16)}</code><span>{instruction.mnemonic}{instruction.operands ? ` ${instruction.operands}` : ''}</span></button>)}</div>
            </section>
          ) : null}
          {node.dataflowUses?.length || node.dataflowDefs?.length || node.dataflowValueKind ? (
            <section className="inspector-section">
              <h4><GitFork size={14} /> Dataflow</h4>
              {node.dataflowValueKind ? <p>value: {node.dataflowValueKind}{node.dataflowValueCount !== undefined ? ` · ${node.dataflowValueCount} use${node.dataflowValueCount === 1 ? '' : 's'}` : ''}</p> : null}
              {node.dataflowUses?.length ? <p>uses: {node.dataflowUses.join(', ')}</p> : null}
              {node.dataflowDefs?.length ? <p>defines: {node.dataflowDefs.join(', ')}</p> : null}
              {node.dataflowLane ? <p>lane: {node.dataflowLane}</p> : null}
            </section>
          ) : null}
          {node.cfiSummary ? (
            <section className="inspector-section">
              <h4><MemoryStick size={14} /> CFI at block entry</h4>
              <p>{node.cfiSummary}</p>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="inspector-empty"><Binary size={24} /><strong>No selection</strong><p>Select a graph node to inspect its evidence and connections.</p></div>
      )}
    </aside>
  );
}
