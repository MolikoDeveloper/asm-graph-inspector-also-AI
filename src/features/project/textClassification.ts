const OBJDUMP_FILE_FORMAT_RE = /^\s*.+:\s+file format\s+\S+\s*$/im;
const OBJDUMP_SECTION_RE = /^\s*Disassembly of section\s+[^:]+:\s*$/im;
const SYMBOL_LINE_RE = /^\s*[0-9a-f]{4,16}\s+<[^>]+>:\s*$/i;
const INSTRUCTION_LINE_RE = /^\s*[0-9a-f]{4,16}:\s+(?:(?:[0-9a-f]{2})\s+){1,15}\S?.*$/i;

export interface TextClassificationEvidence {
  kind: 'asm-source' | 'disassembly-dump' | 'generic-text';
  instructionLines: number;
  symbolLines: number;
  hasObjdumpFileFormat: boolean;
  hasObjdumpSectionHeader: boolean;
}

/**
 * Classify imported text from content, not merely its extension.
 * A few hex-looking lines are insufficient: disassembly requires multiple
 * address+byte instruction rows plus structural objdump/disassembler evidence.
 */
export function classifyTextContent(text: string, declaredAsm = false): TextClassificationEvidence {
  const lines = text.split(/\r?\n/);
  let instructionLines = 0;
  let symbolLines = 0;
  for (const line of lines) {
    if (INSTRUCTION_LINE_RE.test(line)) instructionLines += 1;
    if (SYMBOL_LINE_RE.test(line)) symbolLines += 1;
  }
  const hasObjdumpFileFormat = OBJDUMP_FILE_FORMAT_RE.test(text);
  const hasObjdumpSectionHeader = OBJDUMP_SECTION_RE.test(text);
  const structuralEvidence = hasObjdumpFileFormat || hasObjdumpSectionHeader || symbolLines > 0;
  const isDump = instructionLines >= 2 && structuralEvidence;
  return {
    kind: isDump ? 'disassembly-dump' : declaredAsm ? 'asm-source' : 'generic-text',
    instructionLines,
    symbolLines,
    hasObjdumpFileFormat,
    hasObjdumpSectionHeader
  };
}

export function isDisassemblyDumpText(text: string): boolean {
  return classifyTextContent(text).kind === 'disassembly-dump';
}
