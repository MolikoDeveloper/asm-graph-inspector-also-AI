export interface MutableExecutionStdinState {
  stdinBytes: Uint8Array;
  stdinCursor: number;
}

/**
 * Append bytes to a live execution provider without reintroducing source-level
 * execution semantics. Both browser providers currently keep their stdin queue
 * as Uint8Array + cursor state; this bridge preserves only unread bytes.
 */
export function appendExecutionStdin(target: unknown, text: string): boolean {
  if (!text) return false;
  const candidate = target as MutableExecutionStdinState;
  if (!(candidate?.stdinBytes instanceof Uint8Array) || typeof candidate.stdinCursor !== 'number') return false;

  const cursor = Math.max(0, Math.min(candidate.stdinBytes.length, Math.trunc(candidate.stdinCursor)));
  const unread = candidate.stdinBytes.subarray(cursor);
  const incoming = new TextEncoder().encode(text);
  if (!incoming.length) return false;

  const next = new Uint8Array(unread.length + incoming.length);
  next.set(unread, 0);
  next.set(incoming, unread.length);
  candidate.stdinBytes = next;
  candidate.stdinCursor = 0;
  return true;
}
