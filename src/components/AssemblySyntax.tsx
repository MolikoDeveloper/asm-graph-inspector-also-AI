import type { ReactNode } from 'react';

const REGISTER_RE = /^(?:r(?:1[0-5]|[0-9])(?:b|w|d)?|r(?:ax|bx|cx|dx|si|di|bp|sp)|e(?:ax|bx|cx|dx|si|di|bp|sp)|(?:ax|bx|cx|dx|si|di|bp|sp)|[abcd][lh]|[sd]il|[sb]pl|rip|eip|xmm\d+|ymm\d+|zmm\d+|mm\d+|st\d*|cs|ds|es|fs|gs|ss|cr\d+|dr\d+)$/i;
const NUMBER_RE = /^(?:0x[0-9a-f]+|[0-9]+(?:\.[0-9]+)?|[0-9a-f]+h)$/i;
const DIRECTIVE_RE = /^(?:section|segment|global|extern|bits|default|align|org|gsection|cpu|db|dw|dd|dq|dt|resb|resw|resd|resq|equ|times|use16|use32|use64)$/i;
const MNEMONIC_RE = /^(?:mov|movzx|movsx|movsxd|lea|push|pop|callq?|jmp|j[a-z]+|loop[a-z]*|retq?|iretq?|syscall|sysenter|sysexit|int|add|adc|sub|sbb|mul|imul|div|idiv|inc|dec|neg|not|and|or|xor|cmp|test|shl|shr|sal|sar|rol|ror|rcl|rcr|xchg|nop|leave|ud2|hlt|pause|endbr64|endbr32|cmov[a-z]+|set[a-z]+|bt|btc|btr|bts|bsf|bsr|tzcnt|lzcnt|popcnt|movdqa|movdqu|movaps|movups|pxor|v[a-z0-9]+)$/i;

function tokenClass(token: string, index: number, firstCodeIndex: number): string | null {
  if (REGISTER_RE.test(token)) return 'asm-register';
  if (NUMBER_RE.test(token)) return 'asm-number';
  if (DIRECTIVE_RE.test(token)) return 'asm-directive';
  if (index === firstCodeIndex && MNEMONIC_RE.test(token)) return 'asm-mnemonic';
  if (/^(?:byte|word|dword|qword|tword|oword|yword|zword|ptr|rel|abs|short|near|far)$/i.test(token)) return 'asm-keyword';
  if (/^[.$A-Za-z_][\w.$@?]*:$/.test(token)) return 'asm-label';
  return null;
}

export function highlightAssemblyLine(line: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  let firstCodeIndex = 0;
  while (cursor < line.length && /\s/.test(line[cursor])) cursor += 1;
  const leading = line.slice(0, cursor);
  if (leading) nodes.push(leading);

  let code = line.slice(cursor);
  const labelMatch = code.match(/^([.$A-Za-z_][\w.$@?]*:)(.*)$/);
  if (labelMatch) {
    nodes.push(<span key={`l${nodes.length}`} className="asm-label">{labelMatch[1]}</span>);
    code = labelMatch[2];
  }
  let quote: string | null = null;
  let token = '';
  const flush = () => {
    if (!token) return;
    const className = tokenClass(token, tokenIndex, firstCodeIndex);
    nodes.push(className ? <span key={`t${nodes.length}`} className={className}>{token}</span> : token);
    token = '';
    tokenIndex += 1;
  };

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      token += char;
      if (char === '\\' && index + 1 < code.length) { token += code[++index]; continue; }
      if (char === quote) { nodes.push(<span key={`s${nodes.length}`} className="asm-string">{token}</span>); token = ''; quote = null; tokenIndex += 1; }
      continue;
    }
    if (char === '"' || char === "'") { flush(); quote = char; token = char; continue; }
    if (char === ';') {
      flush();
      nodes.push(<span key={`c${nodes.length}`} className="asm-comment">{code.slice(index)}</span>);
      return nodes;
    }
    if (/\s/.test(char) || /[,\[\](){}+*:\-]/.test(char)) {
      flush();
      nodes.push(char);
      continue;
    }
    token += char;
  }
  if (quote && token) nodes.push(<span key={`s${nodes.length}`} className="asm-string">{token}</span>);
  else flush();
  return nodes;
}

export function HighlightedAssemblyLine({ line }: { line: string }) {
  return <>{highlightAssemblyLine(line)}</>;
}
