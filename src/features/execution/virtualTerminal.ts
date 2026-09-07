export interface VirtualTerminalOptions {
  columns?: number;
  rows?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function blankRow(columns: number): string[] {
  return Array.from({ length: columns }, () => ' ');
}

function parameterList(raw: string): number[] {
  if (!raw || raw === '?') return [];
  return raw.replace(/^\?/, '').split(';').map((value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/**
 * Render a deliberately small VT/ANSI screen model for guest stdout. It covers
 * cursor motion, CR/LF, erase-display/line and SGR ignoring. The execution
 * provider still owns the raw byte stream; this is presentation only.
 */
export function renderVirtualTerminal(input: string, options: VirtualTerminalOptions = {}): string {
  const columns = clamp(options.columns ?? 96, 20, 240);
  const rows = clamp(options.rows ?? 32, 4, 120);
  let screen: string[][] = [blankRow(columns)];
  let row = 0;
  let column = 0;
  let savedRow = 0;
  let savedColumn = 0;

  const ensureRow = () => {
    while (screen.length <= row) screen.push(blankRow(columns));
    while (screen.length > rows) {
      screen.shift();
      row = Math.max(0, row - 1);
      savedRow = Math.max(0, savedRow - 1);
    }
  };

  const clearScreen = () => {
    screen = [blankRow(columns)];
    row = 0;
    column = 0;
    savedRow = 0;
    savedColumn = 0;
  };

  const moveTo = (nextRow: number, nextColumn: number) => {
    row = clamp(nextRow, 0, rows - 1);
    column = clamp(nextColumn, 0, columns - 1);
    ensureRow();
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (char === '\u001b' && input[index + 1] === '[') {
      let end = index + 2;
      while (end < input.length && !/[\x40-\x7e]/.test(input[end])) end += 1;
      if (end >= input.length) break;
      const final = input[end];
      const params = parameterList(input.slice(index + 2, end));
      const first = params[0] ?? 0;
      const amount = Math.max(1, first || 1);

      if (final === 'H' || final === 'f') {
        moveTo(Math.max(0, (params[0] || 1) - 1), Math.max(0, (params[1] || 1) - 1));
      } else if (final === 'A') {
        moveTo(row - amount, column);
      } else if (final === 'B') {
        moveTo(row + amount, column);
      } else if (final === 'C') {
        moveTo(row, column + amount);
      } else if (final === 'D') {
        moveTo(row, column - amount);
      } else if (final === 'G') {
        moveTo(row, Math.max(0, amount - 1));
      } else if (final === 'd') {
        moveTo(Math.max(0, amount - 1), column);
      } else if (final === 'J') {
        if (first === 2 || first === 3) clearScreen();
        else if (first === 0) {
          ensureRow();
          for (let cursor = column; cursor < columns; cursor += 1) screen[row][cursor] = ' ';
          for (let cursorRow = row + 1; cursorRow < screen.length; cursorRow += 1) screen[cursorRow] = blankRow(columns);
        }
      } else if (final === 'K') {
        ensureRow();
        if (first === 2) screen[row] = blankRow(columns);
        else if (first === 1) for (let cursor = 0; cursor <= column; cursor += 1) screen[row][cursor] = ' ';
        else for (let cursor = column; cursor < columns; cursor += 1) screen[row][cursor] = ' ';
      } else if (final === 's') {
        savedRow = row;
        savedColumn = column;
      } else if (final === 'u') {
        moveTo(savedRow, savedColumn);
      }
      // SGR (`m`) and unsupported CSI commands are intentionally ignored.
      index = end;
      continue;
    }

    if (char === '\r') {
      column = 0;
      continue;
    }
    if (char === '\n') {
      row += 1;
      column = 0;
      ensureRow();
      continue;
    }
    if (char === '\b') {
      column = Math.max(0, column - 1);
      continue;
    }
    if (char === '\t') {
      column = Math.min(columns - 1, Math.ceil((column + 1) / 8) * 8);
      continue;
    }
    if (char < ' ' && char !== '\u0000') continue;

    ensureRow();
    screen[row][column] = char;
    column += 1;
    if (column >= columns) {
      column = 0;
      row += 1;
      ensureRow();
    }
  }

  const lines = screen.map((line) => line.join('').replace(/\s+$/g, ''));
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}
