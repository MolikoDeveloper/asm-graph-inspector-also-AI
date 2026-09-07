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

export interface BlinkRuntimeInstructionLine {
  address: bigint;
  bytes: Uint8Array;
  mnemonic: string;
  operands: string;
  lineIndex: number;
}

function parseHexBytes(field: string): Uint8Array | null {
  const tokens = field.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !/^[0-9a-f]{2}$/i.test(token))) return null;
  return Uint8Array.from(tokens.map((token) => Number.parseInt(token, 16)));
}

/**
 * Parse only the stable presentation fields emitted by the pinned Blink fork:
 * address | instruction bytes | assembly text. This remains observational
 * debugger state; it must never replace Capstone as the canonical binary decoder.
 */
export function blinkRuntimeInstructionLine(raw: string, lineIndex = 0): BlinkRuntimeInstructionLine | null {
  const text = blinkDisassemblyLineText(raw);
  const fields = text.split('\t').map((field) => field.trim()).filter((field) => field.length > 0);
  if (fields.length < 3) return null;
  const addressField = fields[0].replace(/^0x/i, '');
  if (!/^[0-9a-f]{6,16}$/i.test(addressField)) return null;
  const bytes = parseHexBytes(fields[1]);
  if (!bytes?.length) return null;
  let address: bigint;
  try { address = BigInt(`0x${addressField}`); }
  catch { return null; }
  const assembly = fields.slice(2).join(' ').trim();
  const match = /^([^\s]+)(?:\s+(.*))?$/.exec(assembly);
  if (!match) return null;
  return {
    address,
    bytes,
    mnemonic: match[1].toLowerCase(),
    operands: match[2]?.trim() ?? '',
    lineIndex
  };
}

export function blinkRuntimeInstructions(lines: string[]): BlinkRuntimeInstructionLine[] {
  const parsed: BlinkRuntimeInstructionLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const instruction = blinkRuntimeInstructionLine(lines[index], index);
    if (instruction) parsed.push(instruction);
  }
  return parsed;
}

export interface BlinkRuntimeByteWindow {
  address: bigint;
  bytes: Uint8Array;
  cursorOffset: number;
  instructionCount: number;
}

/**
 * Build a contiguous byte signature around the architectural RIP. Several
 * neighbouring instructions make module identification substantially safer
 * than matching a single short x86 opcode such as `ret` or `push`.
 */
export function blinkRuntimeByteWindow(lines: string[], rip: bigint, fallback: number, maxBytes = 32): BlinkRuntimeByteWindow | null {
  const parsed = blinkRuntimeInstructions(lines);
  if (!parsed.length) return null;
  let cursor = parsed.findIndex((instruction) => instruction.address === rip);
  if (cursor < 0) {
    const fallbackLine = Math.max(0, Math.min(lines.length - 1, fallback));
    cursor = parsed.findIndex((instruction) => instruction.lineIndex === fallbackLine);
  }
  if (cursor < 0) return null;

  let first = cursor;
  let last = cursor;
  let total = parsed[cursor].bytes.length;
  while (last + 1 < parsed.length && total < maxBytes) {
    const current = parsed[last];
    const next = parsed[last + 1];
    if (current.address + BigInt(current.bytes.length) !== next.address) break;
    if (total + next.bytes.length > maxBytes) break;
    last += 1;
    total += next.bytes.length;
  }
  while (first > 0 && total < Math.min(maxBytes, 12)) {
    const previous = parsed[first - 1];
    const current = parsed[first];
    if (previous.address + BigInt(previous.bytes.length) !== current.address) break;
    if (total + previous.bytes.length > maxBytes) break;
    first -= 1;
    total += previous.bytes.length;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  let cursorOffset = 0;
  for (let index = first; index <= last; index += 1) {
    if (index === cursor) cursorOffset = offset;
    bytes.set(parsed[index].bytes, offset);
    offset += parsed[index].bytes.length;
  }
  return {
    address: parsed[first].address,
    bytes,
    cursorOffset,
    instructionCount: last - first + 1
  };
}

export function blinkRuntimeCursorLine(lines: string[], rip: bigint | null | undefined, fallback: number): number {
  if (rip !== null && rip !== undefined) {
    const exact = lines.findIndex((line) => blinkDisassemblyLineAddress(line) === rip);
    if (exact >= 0) return exact;
  }
  return Math.max(0, Math.min(lines.length - 1, fallback));
}
