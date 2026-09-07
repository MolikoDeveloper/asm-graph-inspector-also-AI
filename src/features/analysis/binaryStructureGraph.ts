import type { BinaryAnalysisSummary, ElfSection, ElfSegment } from '../binary/model';
import type { AnalysisGraph, GraphEdge, GraphNode, GraphNodeProperty } from './model';

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function flags(readable: boolean, writable: boolean, executable: boolean): string {
  return `${readable ? 'R' : '-'}${writable ? 'W' : '-'}${executable ? 'X' : '-'}`;
}

function node(
  id: string,
  title: string,
  detail: string,
  kind: GraphNode['kind'],
  category: string,
  evidence: string,
  properties: GraphNodeProperty[] = [],
  address?: number
): GraphNode {
  return { id, line: 0, title, detail, kind, category, evidence, properties, address, reachable: true };
}

function edge(from: string, to: string, label?: string, kind: GraphEdge['kind'] = 'control'): GraphEdge {
  return { id: `${from}->${to}:${label ?? kind}`, from, to, kind, label };
}

function segmentProperties(segment: ElfSegment): GraphNodeProperty[] {
  return [
    { label: 'Index', value: String(segment.index) },
    { label: 'Permissions', value: flags(segment.readable, segment.writable, segment.executable) },
    { label: 'Virtual range', value: `${hex(segment.virtualAddress)}..${hex(segment.virtualAddress + segment.memorySize)}` },
    { label: 'File range', value: `${hex(segment.offset)}..${hex(segment.offset + segment.fileSize)}` },
    { label: 'File size', value: `${segment.fileSize.toLocaleString()} B` },
    { label: 'Memory size', value: `${segment.memorySize.toLocaleString()} B` },
    { label: 'Alignment', value: hex(segment.alignment) }
  ];
}

function containingSegment(summary: BinaryAnalysisSummary, section: ElfSection): ElfSegment | null {
  if (!section.allocated || section.size <= 0) return null;
  return summary.image.segments.find((segment) =>
    section.address >= segment.virtualAddress &&
    section.address + section.size <= segment.virtualAddress + segment.memorySize
  ) ?? null;
}

function sectionProperties(summary: BinaryAnalysisSummary, section: ElfSection): GraphNodeProperty[] {
  const segment = containingSegment(summary, section);
  return [
    { label: 'Index', value: String(section.index) },
    { label: 'Type', value: hex(section.type) },
    { label: 'Address', value: hex(section.address) },
    { label: 'File offset', value: hex(section.offset) },
    { label: 'Size', value: `${section.size.toLocaleString()} B` },
    { label: 'Permissions', value: flags(section.allocated, section.writable, section.executable) },
    { label: 'Mapped by', value: segment ? `PT_LOAD #${segment.index} (${flags(segment.readable, segment.writable, segment.executable)})` : 'not allocated / no PT_LOAD mapping' }
  ];
}

type SectionGroup = {
  id: string;
  title: string;
  category: string;
  predicate(section: ElfSection): boolean;
};

const SECTION_GROUPS: SectionGroup[] = [
  { id: 'code', title: 'Executable code', category: 'CODE SECTIONS', predicate: (section) => section.allocated && section.executable },
  { id: 'ro', title: 'Read-only data', category: 'READ-ONLY SECTIONS', predicate: (section) => section.allocated && !section.executable && !section.writable },
  { id: 'rw', title: 'Writable data', category: 'WRITABLE SECTIONS', predicate: (section) => section.allocated && section.writable },
  { id: 'meta', title: 'Linker / debug metadata', category: 'METADATA SECTIONS', predicate: (section) => !section.allocated }
];

export function buildBinaryStructureGraph(summary: BinaryAnalysisSummary): AnalysisGraph {
  const image = summary.image;
  const prefix = `${image.sourceFileId}:structure`;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const labels = new Map<string, string>();
  const add = (item: GraphNode) => {
    nodes.push(item);
    if (!labels.has(item.title)) labels.set(item.title, item.id);
    return item.id;
  };

  const rootId = add(node(
    `${prefix}:artifact`,
    image.sourcePath.split('/').at(-1) || image.sourcePath,
    `ELF64 · ${image.architecture} · ${image.kind} · entry ${hex(image.entry)}`,
    'label',
    'BINARY ARTIFACT',
    'Parsed from the imported ELF bytes. This node represents the file as an artifact, not a function CFG.',
    [
      { label: 'Format', value: 'ELF64 little-endian' },
      { label: 'Architecture', value: image.architecture },
      { label: 'Kind', value: image.kind },
      { label: 'Entry point', value: hex(image.entry) },
      { label: 'Build ID', value: image.buildId ?? '—' },
      { label: 'SONAME', value: image.soname ?? '—' },
      { label: 'PT_LOAD mappings', value: String(image.segments.length) },
      { label: 'Sections', value: String(image.sections.length) },
      { label: 'Symbols', value: String(image.symbols.length) },
      { label: 'Functions', value: String(summary.functions.length) },
      { label: 'Relocations', value: String(image.relocations.length) }
    ],
    image.entry
  ));

  const headerId = add(node(
    `${prefix}:header`,
    'ELF Header',
    `${image.kind} · ${image.architecture} · entry ${hex(image.entry)}`,
    'label',
    'FILE HEADER',
    'ELF identity and entry metadata parsed directly from the file header and GNU notes.',
    [
      { label: 'Class', value: 'ELF64' },
      { label: 'Byte order', value: image.byteOrder },
      { label: 'Architecture', value: image.architecture },
      { label: 'Type', value: image.kind },
      { label: 'Entry', value: hex(image.entry) },
      { label: 'Build ID', value: image.buildId ?? '—' }
    ],
    image.entry
  ));
  edges.push(edge(rootId, headerId, 'header'));

  const memoryId = add(node(
    `${prefix}:memory`,
    'Memory image',
    `${image.segments.length} PT_LOAD mapping${image.segments.length === 1 ? '' : 's'}`,
    'label',
    'LOAD MAP',
    'File-backed ELF PT_LOAD mappings define the process image presented to execution and disassembly.',
    [
      { label: 'Mappings', value: String(image.segments.length) },
      { label: 'Executable', value: String(image.segments.filter((segment) => segment.executable).length) },
      { label: 'Writable', value: String(image.segments.filter((segment) => segment.writable).length) }
    ]
  ));
  edges.push(edge(rootId, memoryId, 'loads'));
  for (const segment of image.segments) {
    const segmentId = add(node(
      `${prefix}:segment:${segment.index}`,
      `PT_LOAD #${segment.index}`,
      `${flags(segment.readable, segment.writable, segment.executable)} · ${hex(segment.virtualAddress)}..${hex(segment.virtualAddress + segment.memorySize)}`,
      segment.executable ? 'instruction' : segment.writable ? 'data' : 'label',
      segment.executable ? 'EXECUTABLE LOAD' : segment.writable ? 'WRITABLE LOAD' : 'READ-ONLY LOAD',
      'Raw ELF program-header evidence for a loadable mapping.',
      segmentProperties(segment),
      segment.virtualAddress
    ));
    edges.push(edge(memoryId, segmentId, flags(segment.readable, segment.writable, segment.executable)));
  }

  const sectionsRootId = add(node(
    `${prefix}:sections`,
    'Sections',
    `${image.sections.length} section header${image.sections.length === 1 ? '' : 's'}`,
    'label',
    'SECTION TABLE',
    'Raw ELF section headers grouped by their runtime role. Sections describe file/linker organization; PT_LOAD remains authoritative for runtime mappings.',
    [{ label: 'Section count', value: String(image.sections.length) }]
  ));
  edges.push(edge(rootId, sectionsRootId, 'sections'));

  for (const group of SECTION_GROUPS) {
    const groupSections = image.sections.filter((section) => section.size > 0 && group.predicate(section));
    if (!groupSections.length) continue;
    const groupId = add(node(
      `${prefix}:section-group:${group.id}`,
      group.title,
      `${groupSections.length} section${groupSections.length === 1 ? '' : 's'}`,
      'label',
      group.category,
      'Sections grouped from raw ELF flags; this grouping is presentation only and does not replace ELF metadata.',
      [{ label: 'Count', value: String(groupSections.length) }]
    ));
    edges.push(edge(sectionsRootId, groupId));

    const visible = groupSections.slice(0, 24);
    for (const section of visible) {
      const sectionId = add(node(
        `${prefix}:section:${section.index}`,
        section.name || `section #${section.index}`,
        `${section.size.toLocaleString()} B · ${flags(section.allocated, section.writable, section.executable)} · ${hex(section.address)}`,
        section.executable ? 'instruction' : 'data',
        'ELF SECTION',
        `Raw ELF section header #${section.index}.`,
        sectionProperties(summary, section),
        section.allocated && section.size ? section.address : undefined
      ));
      edges.push(edge(groupId, sectionId));
    }
    if (groupSections.length > visible.length) {
      const omitted = groupSections.length - visible.length;
      const omittedId = add(node(
        `${prefix}:section-group:${group.id}:more`,
        `+ ${omitted} more section${omitted === 1 ? '' : 's'}`,
        'Open Disassembly → Sections for the complete raw table.',
        'label',
        'COLLAPSED',
        'The structure graph intentionally caps large section groups to keep the topology readable.',
        [{ label: 'Hidden from graph', value: String(omitted) }]
      ));
      edges.push(edge(groupId, omittedId));
    }
  }

  const runtimeId = add(node(
    `${prefix}:runtime`,
    'Dynamic runtime',
    image.interpreter || image.neededLibraries.length ? `${image.neededLibraries.length} DT_NEEDED · ${image.interpreter ? 'PT_INTERP' : 'no interpreter'}` : 'static / no dynamic runtime metadata',
    'call',
    'DYNAMIC LINKAGE',
    'Runtime linkage derived from PT_INTERP, DT_NEEDED and the materialized Global Dependency closure.',
    [
      { label: 'Interpreter', value: image.interpreter ?? '—' },
      { label: 'Direct DT_NEEDED', value: image.neededLibraries.join(', ') || '—' },
      { label: 'Resolved closure entries', value: String(summary.dependencies.filter((dependency) => dependency.status === 'resolved').length) }
    ]
  ));
  edges.push(edge(rootId, runtimeId, 'runtime', 'call'));

  if (image.interpreter) {
    const interpreterResolution = summary.dependencies.find((dependency) => dependency.role === 'interpreter');
    const interpreterId = add(node(
      `${prefix}:interpreter`,
      image.interpreter.split('/').at(-1) || image.interpreter,
      interpreterResolution ? `${interpreterResolution.status} · ${image.interpreter}` : image.interpreter,
      'call',
      'ELF INTERPRETER',
      interpreterResolution?.evidence ?? 'PT_INTERP path from the ELF.',
      [
        { label: 'Requested path', value: image.interpreter },
        { label: 'Status', value: interpreterResolution?.status ?? 'not materialized' },
        { label: 'Provider', value: interpreterResolution?.sourceName ?? interpreterResolution?.fileName ?? '—' }
      ]
    ));
    edges.push(edge(runtimeId, interpreterId, 'PT_INTERP', 'call'));
  }

  for (const [index, dependency] of summary.dependencies.entries()) {
    if (dependency.role === 'interpreter') continue;
    const dependencyId = add(node(
      `${prefix}:dependency:${index}:${dependency.requestedName}`,
      dependency.requestedName,
      `${dependency.status} · ${dependency.role}${dependency.requestedBy ? ` · by ${dependency.requestedBy}` : ''}`,
      'call',
      dependency.status === 'resolved' ? 'RESOLVED DEPENDENCY' : dependency.status === 'permission-required' ? 'PERMISSION REQUIRED' : 'UNRESOLVED DEPENDENCY',
      dependency.evidence,
      [
        { label: 'Role', value: dependency.role },
        { label: 'Depth', value: String(dependency.depth) },
        { label: 'Requested by', value: dependency.requestedBy ?? image.sourcePath },
        { label: 'Resolution', value: dependency.status },
        { label: 'Provider', value: dependency.sourceName ?? dependency.fileName ?? '—' },
        { label: 'SONAME', value: dependency.soname ?? '—' },
        { label: 'Needs', value: dependency.neededLibraries.join(', ') || '—' }
      ]
    ));
    edges.push(edge(runtimeId, dependencyId, dependency.role === 'direct' ? 'DT_NEEDED' : 'transitive', 'call'));
  }

  const linkageId = add(node(
    `${prefix}:linkage`,
    'Symbols & linkage',
    `${image.symbols.length} symbols · ${image.relocations.length} relocations · ${summary.pltStubs.length} PLT stubs`,
    'call',
    'LINKER VIEW',
    'Raw symbol/relocation tables plus PLT linkage recovered from ELF bytes and Capstone.',
    [
      { label: 'Symbols', value: String(image.symbols.length) },
      { label: 'Relocations', value: String(image.relocations.length) },
      { label: 'PLT stubs', value: String(summary.pltStubs.length) }
    ]
  ));
  edges.push(edge(rootId, linkageId, 'linkage'));

  if (summary.pltStubs.length) {
    const pltId = add(node(
      `${prefix}:plt`,
      'PLT / GOT',
      `${summary.pltStubs.length} proven linkage stub${summary.pltStubs.length === 1 ? '' : 's'}`,
      'call',
      'DYNAMIC CALL STUBS',
      'PLT stubs are recovered from executable bytes, RIP-relative GOT references and raw relocations.',
      [
        { label: 'Stub count', value: String(summary.pltStubs.length) },
        { label: 'Examples', value: summary.pltStubs.slice(0, 8).map((stub) => stub.name).join(', ') || '—' }
      ],
      summary.pltStubs[0]?.address
    ));
    edges.push(edge(linkageId, pltId, 'PLT', 'call'));
  }

  if (image.relocations.length) {
    const relocationId = add(node(
      `${prefix}:relocations`,
      'Relocations',
      `${image.relocations.length} REL/RELA entr${image.relocations.length === 1 ? 'y' : 'ies'}`,
      'data',
      'RELOCATION TABLES',
      'Raw ELF relocation records. Open Disassembly → Relocs for the complete table.',
      [{ label: 'Count', value: String(image.relocations.length) }],
      image.relocations[0]?.offset
    ));
    edges.push(edge(linkageId, relocationId));
  }

  const functionsId = add(node(
    `${prefix}:functions`,
    'Functions',
    `${summary.functions.length} discovered · active ${summary.rootName}`,
    'instruction',
    'DISCOVERED CODE',
    'Function discovery combines symbols, unwind ranges, entrypoint and conservative code evidence.',
    [
      { label: 'Discovered', value: String(summary.functions.length) },
      { label: 'Active function', value: `${summary.rootName} @ ${hex(summary.rootAddress)}` },
      { label: 'Entrypoint', value: hex(image.entry) }
    ],
    summary.rootAddress
  ));
  edges.push(edge(rootId, functionsId, 'code'));

  const representativeFunctions = summary.functions
    .filter((candidate, index, all) => candidate.address === image.entry || candidate.address === summary.rootAddress || index < 8)
    .filter((candidate, index, all) => all.findIndex((other) => other.address === candidate.address) === index)
    .slice(0, 10);
  for (const candidate of representativeFunctions) {
    const functionId = add(node(
      `${prefix}:function:${candidate.address.toString(16)}`,
      candidate.name,
      `${hex(candidate.address)} · ${candidate.kind} · ${candidate.confidence}`,
      'instruction',
      candidate.address === image.entry ? 'ENTRY FUNCTION' : candidate.address === summary.rootAddress ? 'ACTIVE FUNCTION' : 'FUNCTION SAMPLE',
      candidate.evidence,
      [
        { label: 'Address', value: hex(candidate.address) },
        { label: 'End', value: candidate.endAddress === null ? 'unknown' : hex(candidate.endAddress) },
        { label: 'Size', value: candidate.size === null ? 'unknown' : `${candidate.size} B` },
        { label: 'Section', value: candidate.sectionName },
        { label: 'Evidence kind', value: candidate.kind },
        { label: 'Confidence', value: candidate.confidence }
      ],
      candidate.address
    ));
    edges.push(edge(functionsId, functionId));
  }
  if (summary.functions.length > representativeFunctions.length) {
    const remaining = summary.functions.length - representativeFunctions.length;
    const moreFunctionsId = add(node(
      `${prefix}:functions:more`,
      `+ ${remaining} more function${remaining === 1 ? '' : 's'}`,
      'Open Disassembly → Functions for the full discovered function tree.',
      'label',
      'COLLAPSED',
      'The structure graph shows representative functions while the dedicated function browser remains the complete function view.',
      [{ label: 'Not expanded here', value: String(remaining) }]
    ));
    edges.push(edge(functionsId, moreFunctionsId));
  }

  const unwindId = add(node(
    `${prefix}:unwind`,
    'Unwind / CFI',
    `${image.unwind.fdes.length} FDE · ${image.unwind.cfiRowCount} decoded CFI rows`,
    'data',
    'UNWIND METADATA',
    'DWARF CFI evidence parsed from .eh_frame / .debug_frame when present.',
    [
      { label: 'CIE', value: String(image.unwind.cies.length) },
      { label: 'FDE', value: String(image.unwind.fdes.length) },
      { label: 'CFI rows', value: String(image.unwind.cfiRowCount) },
      { label: 'Diagnostics', value: String(image.unwind.errors.length + image.unwind.cfiDiagnostics.length) }
    ],
    image.unwind.fdes[0]?.startAddress
  ));
  edges.push(edge(rootId, unwindId, 'unwind'));

  return {
    fileId: image.sourceFileId,
    nodes,
    edges,
    labels,
    diagnostics: [
      `Binary structure: ${nodes.length} visual nodes from raw ELF metadata and canonical binary analysis.`,
      'This graph describes artifact composition. Function CFG and Program Flow remain separate control-flow views.'
    ],
    sourceKind: 'raw-elf-capstone',
    architecture: image.architecture,
    entryAddress: image.entry,
    viewKind: 'binary-structure'
  };
}
