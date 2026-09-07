import { analyzeDisassemblyDump, parseDisassemblyDump } from '../../src/features/analysis/disassemblyDump';
import { importBrowserFile } from '../../src/features/project/fileImport';
import { classifyTextContent } from '../../src/features/project/textClassification';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

const dump = `sample.bin:     file format elf64-x86-64

Disassembly of section .text:

0000000000401000 <_start>:
  401000: 48 31 c0                xor    rax,rax
  401003: e8 08 00 00 00          call   401010 <target>
  401008: eb 06                   jmp    401010 <target>

0000000000401010 <target>:
  401010: c3                      ret
`;

const classification = classifyTextContent(dump, true);
assertEqual(classification.kind, 'disassembly-dump', 'objdump classification');
assert(classification.instructionLines >= 4, 'objdump instruction evidence');
assert(classification.hasObjdumpFileFormat, 'objdump file-format evidence');
assert(classification.hasObjdumpSectionHeader, 'objdump section evidence');

const source = `bits 64
global _start
section .text
_start:
  mov rax, 0x401000
  xor rdi, rdi
  syscall
`;
assertEqual(classifyTextContent(source, true).kind, 'asm-source', 'real ASM must not be reclassified as a dump');

const document = parseDisassemblyDump(dump);
assertEqual(document.instructions.length, 4, 'parsed dump instruction count');
assertEqual(document.symbols.length, 2, 'parsed dump symbol count');
assertEqual(document.instructions[0]?.address, 0x401000, 'first dump instruction address');
assertEqual(document.instructions[0]?.bytes.join(' '), '72 49 192', 'first dump instruction bytes');

const graph = analyzeDisassemblyDump('dump-file', dump);
assertEqual(graph.sourceKind, 'disassembly-dump', 'dump graph source kind');
assertEqual(graph.entryAddress, 0x401000, 'dump graph entry evidence');
assert(graph.nodes.some((node) => node.address === 0x401010 && node.title === 'target'), 'dump symbol node');
assert(graph.edges.some((edge) => edge.kind === 'call' && edge.label === 'call evidence'), 'dump call evidence edge');
assert(graph.edges.some((edge) => edge.kind === 'branch' && edge.label === 'branch evidence'), 'dump branch evidence edge');
assert(graph.diagnostics.some((message) => message.includes('authoritative ELF bytes')), 'dump graph must state evidence-only semantics');

const importedDump = await importBrowserFile(new File([dump], 'misleading.asm', { type: 'text/plain' }));
assertEqual(importedDump.kind, 'text', 'dump import kind');
assertEqual(importedDump.language, 'disassembly-dump', 'content overrides misleading .asm extension');

const importedSource = await importBrowserFile(new File([source], 'real.asm', { type: 'text/plain' }));
assertEqual(importedSource.language, 'asm', 'real ASM import language');

console.log('disassembly dump smoke: PASS (content classification -> dedicated evidence parser; .asm extension cannot force NASM source semantics)');
