import { resolve } from 'node:path';
import { isElfBytes, runAsmHeadless, runElfHeadless } from '../src/features/execution/headless/runner';
import type { ExecutionEvent, ExecutionSnapshot } from '../src/features/execution/model';
import { loadHeadlessCapstone } from './headless-capstone';

interface CliOptions {
  path: string;
  json: boolean;
  trace: boolean;
  stdin: string;
  maxInstructions?: number;
}

function usage(): never {
  console.error(`Usage: bun run execute -- <file.asm|elf> [options]\n\nOptions:\n  --json                 Print a machine-readable result.\n  --trace                Print observed instruction/syscall events to stderr.\n  --stdin <text>          Virtual stdin passed to Linux Lite / bounded execution.\n  --max-instructions <n> Override the execution instruction budget.\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  let path = '';
  let json = false;
  let trace = false;
  let stdin = '';
  let maxInstructions: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--trace') { trace = true; continue; }
    if (arg === '--stdin') { stdin = argv[++index] ?? usage(); continue; }
    if (arg === '--max-instructions') {
      const parsed = Number(argv[++index]);
      if (!Number.isInteger(parsed) || parsed <= 0) usage();
      maxInstructions = parsed;
      continue;
    }
    if (arg.startsWith('-')) usage();
    if (path) usage();
    path = arg;
  }
  if (!path) usage();
  return { path, json, trace, stdin, maxInstructions };
}

function jsonSnapshot(snapshot: ExecutionSnapshot, elapsedMs: number) {
  return {
    ok: snapshot.status === 'exited' || snapshot.status === 'halted',
    status: snapshot.status,
    provider: snapshot.provider,
    instructionCount: snapshot.instructionCount,
    exitCode: snapshot.exitCode,
    trapReason: snapshot.trapReason,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    elapsedMs,
    registers: snapshot.registers ? Object.fromEntries(Object.entries(snapshot.registers).map(([key, value]) => [key, `0x${value.toString(16)}`])) : null,
    lastInstruction: snapshot.lastInstruction
  };
}

function traceLine(event: ExecutionEvent): string | null {
  if (event.kind === 'instruction') return `0x${event.address.toString(16)}  ${event.mnemonic}${event.operands ? ` ${event.operands}` : ''}${event.line ? `  [line ${event.line}]` : ''}`;
  if (event.kind === 'syscall') return `syscall ${event.number} ${event.name}: ${event.detail}`;
  if (event.kind === 'exit') return `exit(${event.code})`;
  if (event.kind === 'trap') return `trap: ${event.reason}`;
  if (event.kind === 'halt') return `halt: ${event.reason}`;
  return null;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const path = resolve(cli.path);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`File not found: ${path}`);
    process.exitCode = 2;
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const common = { stdin: cli.stdin, maxInstructions: cli.maxInstructions };
    let result;
    if (isElfBytes(bytes)) {
      const capstone = await loadHeadlessCapstone();
      result = runElfHeadless(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { ...common, capstone });
    } else {
      result = runAsmHeadless(path, new TextDecoder().decode(bytes), common);
    }

    if (cli.trace) {
      for (const event of result.snapshot.events) {
        const line = traceLine(event);
        if (line) console.error(line);
      }
    }

    if (cli.json) console.log(JSON.stringify(jsonSnapshot(result.snapshot, result.elapsedMs), null, 2));
    else {
      if (result.snapshot.stdout) process.stdout.write(result.snapshot.stdout);
      if (result.snapshot.stderr) process.stderr.write(result.snapshot.stderr);
      if (result.snapshot.status === 'trapped') console.error(`\n[trap] ${result.snapshot.trapReason ?? 'unknown trap'}`);
      else if (result.snapshot.status === 'halted') console.error(`\n[halted] execution halted`);
    }

    process.exitCode = result.snapshot.status === 'exited'
      ? (result.snapshot.exitCode ?? 0)
      : result.snapshot.status === 'trapped'
        ? 125
        : result.snapshot.status === 'halted'
          ? 126
          : 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (cli.json) console.log(JSON.stringify({ ok: false, status: 'error', error: message }, null, 2));
    else console.error(`[execution error] ${message}`);
    process.exitCode = 125;
  }
}

await main();
