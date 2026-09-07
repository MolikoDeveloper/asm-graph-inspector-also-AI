import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseElfImage, inspectElfRuntimeLinkage } from '../../src/features/binary/elfParser';
import type { ProjectFile } from '../../src/features/project/model';
import { prepareLinuxRuntimeEnvironment } from '../../src/features/execution/linuxRuntimeEnvironment';
import type { MaterializedRuntimeModule, RuntimeDependencyClosure } from '../../src/features/execution/runtimeDependencies';
import { UnicornLinuxProcessSession } from '../../src/features/execution/unicornLinuxProcessSession';
import type { UnicornFactory } from '../../src/features/execution/unicornTypes';
import type { ExecutionPolicy, ExecutionSnapshot } from '../../src/features/execution/model';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';

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

function failureContext(snapshot: ExecutionSnapshot): string {
  const instruction = snapshot.lastInstruction
    ? `last=0x${snapshot.lastInstruction.address.toString(16)} ${snapshot.lastInstruction.mnemonic}${snapshot.lastInstruction.operands ? ` ${snapshot.lastInstruction.operands}` : ''}`
    : 'last=<none>';
  const runtime = snapshot.runtimeDisassembly?.image
    ? `runtime=${snapshot.runtimeDisassembly.image.role}:${snapshot.runtimeDisassembly.image.name} rip=0x${snapshot.runtimeDisassembly.image.runtimeAddress.toString(16)} image=0x${snapshot.runtimeDisassembly.image.imageAddress.toString(16)}`
    : 'runtime=<unresolved>';
  const syscalls = snapshot.events
    .filter((event) => event.kind === 'syscall')
    .slice(-12)
    .map((event) => event.kind === 'syscall' ? `${event.name}(${event.detail})` : '')
    .join(' <- ');
  const diagnostics = snapshot.providerDiagnostics.slice(-3).map((entry) => entry.message).join(' | ');
  return [snapshot.trapReason ?? 'dynamic Unicorn session did not exit', instruction, runtime, `instructions=${snapshot.instructionCount}`, `recent-syscalls=${syscalls || '<none>'}`, `provider=${diagnostics || '<none>'}`].join(' ; ');
}

const temp = mkdtempSync(join(tmpdir(), 'asm-graph-unicorn-linux-'));
try {
  const source = join(temp, 'hello.c');
  const executable = join(temp, 'hello');
  writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("hello from unicorn dynamic glibc"); return 0; }\n');
  execFileSync('cc', ['-O0', '-fno-pie', '-no-pie', source, '-o', executable], { stdio: 'inherit' });

  const executableBytes = exactArrayBuffer(readFileSync(executable));
  const file: ProjectFile = {
    id: 'unicorn-linux-dynamic-fixture',
    path: 'build/unicorn-linux-dynamic-fixture',
    name: 'unicorn-linux-dynamic-fixture',
    kind: 'binary',
    language: 'binary',
    bytes: executableBytes,
    size: executableBytes.byteLength,
    updatedAt: 1
  };
  const image = parseElfImage(file.id, file.path, executableBytes);
  assert.ok(image.interpreter, 'host dynamic fixture must expose PT_INTERP');
  assert.ok(image.neededLibraries.includes('libc.so.6'), 'host dynamic fixture must depend on libc.so.6');

  const loaderPath = firstExisting([
    image.interpreter!,
    '/lib64/ld-linux-x86-64.so.2',
    '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
  ]);
  const libcPath = firstExisting([
    '/lib/x86_64-linux-gnu/libc.so.6',
    '/usr/lib/x86_64-linux-gnu/libc.so.6'
  ]);
  const loaderName = image.interpreter!.split('/').at(-1)!;
  const modules = [materialized(loaderName, loaderPath), materialized('libc.so.6', libcPath)];
  const closure: RuntimeDependencyClosure = {
    interpreterPath: image.interpreter,
    modules,
    totalBytes: modules.reduce((sum, module) => sum + module.bytes.byteLength, 0)
  };
  const environment = await prepareLinuxRuntimeEnvironment(file, image, {
    materialize: async () => closure
  });
  assert.equal(environment.symbolVersions.compatible, true, 'host libc/loader must satisfy the executable symbol-version contract');

  const runtimeBytes = readFileSync(resolve('public/vendor/unicorn/unicorn_x86.js'));
  const runtime = join(temp, 'unicorn_x86.cjs');
  writeFileSync(runtime, runtimeBytes);
  const factory = createRequire(import.meta.url)(runtime) as UnicornFactory;
  const [unicorn, capstone] = await Promise.all([factory(), loadHeadlessCapstone()]);
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
    assert.equal(snapshot.provider, 'unicorn-linux');
    for (let slices = 0; slices < 20_000 && (snapshot.status === 'ready' || snapshot.status === 'running' || snapshot.status === 'paused'); slices += 1) {
      snapshot = session.runSlice(500);
      if (snapshot.status === 'exited' || snapshot.status === 'trapped' || snapshot.status === 'halted') break;
    }
    assert.equal(snapshot.status, 'exited', failureContext(snapshot));
    assert.equal(snapshot.exitCode, 0);
    assert.match(snapshot.stdout, /hello from unicorn dynamic glibc/);
    assert.ok(snapshot.events.some((event) => event.kind === 'trace-gap'), 'dynamic startup must cross loader/dependency execution boundaries');
    console.log(`Unicorn Linux dynamic smoke: PASS (${snapshot.instructionCount.toLocaleString()} instructions, loader + libc from explicit runtime closure)`);
  } finally {
    session.dispose();
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
