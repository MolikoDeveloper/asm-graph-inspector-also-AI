import type { ExecutionProviderDiagnostic } from './model';

const MAX_DIAGNOSTICS = 80;
const MAX_MESSAGE_LENGTH = 1200;

function normalizeMessage(value: unknown): string {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '(empty provider diagnostic)';
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

export class ExecutionProviderDiagnosticBuffer {
  private readonly entries: ExecutionProviderDiagnostic[] = [];

  add(level: ExecutionProviderDiagnostic['level'], value: unknown): void {
    const message = normalizeMessage(value);
    const previous = this.entries.at(-1);
    if (previous && previous.level === level && previous.message === message) {
      previous.count += 1;
      return;
    }
    this.entries.push({ level, message, count: 1 });
    if (this.entries.length > MAX_DIAGNOSTICS) this.entries.splice(0, this.entries.length - MAX_DIAGNOSTICS);
  }

  snapshot(): ExecutionProviderDiagnostic[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

export function describeExecutionError(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack?.trim();
    if (stack && stack !== error.message) return stack;
    return error.message;
  }
  return normalizeMessage(error);
}
