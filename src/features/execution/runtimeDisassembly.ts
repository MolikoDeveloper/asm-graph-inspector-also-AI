const HTML_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, ' '],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
  [/&amp;/gi, '&']
];

/**
 * Blink's debugger disassembler exposes presentation-oriented table markup.
 * Keep provider HTML out of React and convert it to inert text before render.
 */
export function blinkDisassemblyLineText(raw: string): string {
  let text = raw
    .replace(/<\s*\/\s*td\s*>/gi, '\t')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  for (const [pattern, replacement] of HTML_ENTITIES) text = text.replace(pattern, replacement);
  return text.replace(/[ \t]+$/g, '');
}

export function blinkDisassemblyLineAddress(raw: string): bigint | null {
  const firstField = blinkDisassemblyLineText(raw).trimStart().split(/[\t\s]/, 1)[0]?.replace(/^0x/i, '') ?? '';
  if (!/^[0-9a-f]{6,16}$/i.test(firstField)) return null;
  try { return BigInt(`0x${firstField}`); }
  catch { return null; }
}

export function blinkRuntimeCursorLine(lines: string[], rip: bigint | null | undefined, fallback: number): number {
  if (rip !== null && rip !== undefined) {
    const exact = lines.findIndex((line) => blinkDisassemblyLineAddress(line) === rip);
    if (exact >= 0) return exact;
  }
  return Math.max(0, Math.min(lines.length - 1, fallback));
}
