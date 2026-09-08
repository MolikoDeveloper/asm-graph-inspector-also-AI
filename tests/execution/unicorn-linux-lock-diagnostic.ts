import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectElfRuntimeLinkage, parseElfImage } from '../../src/features/binary/elfParser';
import type { LoadedImage } from '../../src/features/binary/model';
import type { ProjectFile } from '../../src/features/project/model';
import { prepareLinuxRuntimeEnvironment } from '../../src/features/execution/linuxRuntimeEnvironment';
import type { MaterializedRuntimeModule, RuntimeDependencyClosure } from '../../src/features/execution/runtimeDependencies';
import { UnicornLinuxProcessSession } from '../../src/features/execution/unicornLinuxProcessSession';
import type { UnicornEngine, UnicornFactory, UnicornModule } from '../../src/features/execution/unicornTypes';
import type { ExecutionPolicy } from '../../src/features/execution/model';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';

interface WriteTrace {
  rip: bigint;
  address: bigint;
  size: number;
  value: bigint;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function firstExisting(candidates: string[]): string {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`None of the required runtime paths exist: ${candidates.join(', ')}`);
  return found;
}

function materialized(requestedName: string, path: string): MaterializedRuntimeModule {
  const bytes = exactArrayBuffer(readFileSync(path));
  const linkage = inspectElfRuntimeLinkage(bytes);
  return {
    requestedName,
    fileName: requestedName,
    soname: linkage.soname,
    bytes,
    neededLibraries: linkage.neededLibraries,
    sourceId: `host-fixture:${requestedName}`,
    sourceKind: 'file',
    sourceName: requestedName
  };
}

function readU32(engine: UnicornEngine, address: bigint): number {
  const bytes = engine.mem_read(address, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

function readU64(engine: UnicornEngine, address: bigint): bigint {
  const bytes = engine.mem_read(address, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

function findDynamicSymbol(path: string, name: string): number | null {
  const symbols = execFileSync('readelf', ['-Ws', path], { encoding: 'utf8' });
  for (const line of symbols.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 8) continue;
    const symbolName = columns.slice(7).join(' ').split('@')[0];
    if (symbolName !== name) continue;
    const value = Number.parseInt(columns[1], 16);
    if (Number.isSafeInteger(value)) return value;
  }
  return null;
}

function instrumentModule(module: UnicornModule, onEngine: (engine: UnicornEngine) => void, writes: WriteTrace[]): UnicornModule {
  const OriginalUnicorn = module.Unicorn;
  const InstrumentedUnicorn = class {
    constructor(arch: number, mode: number) {
      const engine = new OriginalUnicorn(arch, mode);
      onEngine(engine);
      engine.hook_add(module.HOOK_MEM_WRITE, (...args: unknown[]) => {
        const addressValue = args[2];
        const sizeValue = args[3];
        const valueValue = args[4];
        const address = typeof addressValue === 'bigint' ? addressValue : BigInt(Number(addressValue));
        if (address < 0x0000_7000_0000_0000n || address >= 0x0000_7100_0000_0000n) return;
        const size = Number(sizeValue);
        const value = typeof valueValue === 'bigint' ? BigInt.asUintN(64, valueValue) : BigInt.asUintN(64, BigInt(Number(valueValue) >>> 0));
        let rip = 0n;
        try { rip = engine.reg_read_i64(module.X86_REG_RIP); } catch { /* diagnostic only */ }
        writes.push({ rip, address, size, value });
        if (writes.length > 20_000) writes.splice(0, writes.length - 20_000);
      });
      return engine;
    }
  } as unknown as UnicornModule['Unicorn'];
  return new Proxy(module, {
    get(target, property, receiver) {
      return property === 'Unicorn' ? InstrumentedUnicorn : Reflect.get(target, property, receiver);
    }
  });
}

function overlap(write: WriteTrace, start: bigint, size: bigint): boolean {
  const end = write.address + BigInt(Math.max(1, write.size));
  return write.address < start + size && end > start;
}

function formatWrite(write: WriteTrace): string {
  return `rip=0x${write.rip.toString(16)} addr=0x${write.address.toString(16)} size=${write.size} value=0x${write.value.toString(16)}`;
}

const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-lock-diagnostic-'));
try {
  const source = join(temp, 'hello.c');
  const executable = join(temp, 'hello');
  writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("hello from unicorn dynamic glibc"); return 0; }\n');
  execFileSync('cc', ['-O0', '-fno-pie', '-no-pie', source, '-o', executable], { stdio: 'inherit' });

  const executableBytes = exactArrayBuffer(readFileSync(executable));
  const file: ProjectFile = {
    id: 'unicorn-linux-lock-diagnostic',
    path: 'build/unicorn-linux-lock-diagnostic',
    name: 'unicorn-linux-lock-diagnostic',
    kind: 'binary',
    language: 'binary',
    bytes: executableBytes,
    size: executableBytes.byteLength,
    updatedAt: 1
  };
  const image = parseElfImage(file.id, file.path, executableBytes);
  assert.ok(image.interpreter);

  const loaderPath = firstExisting([image.interpreter!, '/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2']);
  const libcPath = firstExisting(['/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib/x86_64-linux-gnu/libc.so.6']);
  const loaderName = image.interpreter!.split('/').at(-1)!;
  const modules = [materialized(loaderName, loaderPath), materialized('libc.so.6', libcPath)];
  const closure: RuntimeDependencyClosure = {
    interpreterPath: image.interpreter,
    modules,
    totalBytes: modules.reduce((sum, module) => sum + module.bytes.byteLength, 0)
  };
  const environment = await prepareLinuxRuntimeEnvironment(file, image, { materialize: async () => closure });

  const factory = createRequire(import.meta.url)(resolve('public/vendor/unicorn/unicorn_x86.js')) as UnicornFactory;
  const [rawUnicorn, capstone] = await Promise.all([factory(), loadHeadlessCapstone()]);
  const writes: WriteTrace[] = [];
  let engine: UnicornEngine | null = null;
  const unicorn = instrumentModule(rawUnicorn, (created) => { engine = created; }, writes);
  const policy: ExecutionPolicy = {
    maxInstructions: 2_000_000,
    maxMappedBytes: 256 * 1024 * 1024,
    stackBytes: 2 * 1024 * 1024,
    syscallPolicy: 'stdio-exit',
    stdin: ''
  };
  const session = UnicornLinuxProcessSession.createWithModules(file, image, environment, unicorn, capstone, policy);
  try {
    let snapshot = session.snapshot();
    for (let slices = 0; slices < 20_000 && (snapshot.status === 'ready' || snapshot.status === 'running' || snapshot.status === 'paused'); slices += 1) {
      snapshot = session.runSlice(500);
      if (snapshot.status === 'exited' || snapshot.status === 'trapped' || snapshot.status === 'halted') break;
    }
    assert.ok(engine, 'instrumented Unicorn engine must be captured');
    assert.equal(snapshot.status, 'trapped', 'diagnostic is expected to reach the current futex blocker');
    assert.match(snapshot.trapReason ?? '', /Linux futex WAIT at 0x[0-9a-f]+ would block/);

    const match = snapshot.trapReason!.match(/WAIT at 0x([0-9a-f]+) would block/)!;
    const lockAddress = BigInt(`0x${match[1]}`);
    const lock = readU32(engine, lockAddress);
    const count = readU32(engine, lockAddress + 4n);
    const owner = readU64(engine, lockAddress + 8n);
    const fsBase = engine.reg_read_i64(rawUnicorn.X86_REG_FS_BASE);
    let fsSelf: bigint | null = null;
    try { fsSelf = readU64(engine, fsBase + 0x10n); } catch { /* diagnostic only */ }

    const runtime = snapshot.runtimeDisassembly?.image;
    const libcBase = runtime?.name === 'libc.so.6' ? runtime.loadBias : null;
    const singleThreadOffset = findDynamicSymbol(libcPath, '__libc_single_threaded');
    let singleThread: number | null = null;
    let singleThreadAddress: bigint | null = null;
    if (libcBase !== null && singleThreadOffset !== null) {
      singleThreadAddress = libcBase + BigInt(singleThreadOffset);
      singleThread = engine.mem_read(singleThreadAddress, 1)[0];
    }

    const lockWrites = writes.filter((write) => overlap(write, lockAddress, 16n));
    const singleThreadWrites = singleThreadAddress === null ? [] : writes.filter((write) => overlap(write, singleThreadAddress!, 1n));
    console.log([
      `Unicorn dynamic lock diagnostic: PASS`,
      `lock=0x${lockAddress.toString(16)} state=${lock} count=${count} owner=0x${owner.toString(16)}`,
      `fs-base=0x${fsBase.toString(16)} fs:[0x10]=${fsSelf === null ? '<unreadable>' : `0x${fsSelf.toString(16)}`}`,
      `__libc_single_threaded=${singleThread === null ? '<unresolved>' : singleThread}${singleThreadAddress === null ? '' : ` @0x${singleThreadAddress.toString(16)}`}`,
      `lock-writes=${lockWrites.length}: ${lockWrites.map(formatWrite).join(' <- ') || '<none>'}`,
      `single-thread-writes=${singleThreadWrites.length}: ${singleThreadWrites.map(formatWrite).join(' <- ') || '<none>'}`
    ].join(' ; '));
  } finally {
    session.dispose();
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
