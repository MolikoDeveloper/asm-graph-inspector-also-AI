import { NasmLdAssemblerBackend } from '../../src/features/toolchain/nasmLdBackend';
import type { ToolProcessRequest, ToolProcessResult, ToolProcessRunner } from '../../src/features/toolchain/toolProcess';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeRunner implements ToolProcessRunner {
  readonly requests: ToolProcessRequest[] = [];

  async run(request: ToolProcessRequest): Promise<ToolProcessResult> {
    this.requests.push(request);
    const capture = request.captureFiles[0];
    if (request.executable.endsWith('/nasm')) {
      const marker = new TextEncoder().encode(`OBJ:${request.args[2]}`);
      return { exitCode: 0, stdout: '', stderr: '', files: [{ path: capture, bytes: marker }] };
    }
    if (request.executable.endsWith('/ld')) {
      return { exitCode: 0, stdout: 'linked\n', stderr: '', files: [{ path: capture, bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) }] };
    }
    throw new Error(`unexpected tool ${request.executable}`);
  }
}

const runner = new FakeRunner();
const backend = new NasmLdAssemblerBackend(runner);
const result = await backend.assemble({
  sources: [
    { path: 'src/main.asm', source: 'global _start\n_start:\n  call helper\n  ret\n' },
    { path: 'src/helper.asm', source: 'global helper\nhelper:\n  ret\n' }
  ],
  entrySymbol: '_start',
  outputPath: '/work/build/demo'
});

assert(result.success, 'NASM + ld orchestration should succeed');
assert(result.artifact?.kind === 'elf-executable', 'final artifact should be an ELF executable');
assert(result.artifact?.path === '/work/build/demo', 'final artifact path should be preserved');
assert(result.artifact?.bytes[0] === 0x7f && result.artifact?.bytes[1] === 0x45, 'final ELF bytes should come from linker output');
assert(result.generatedArtifacts.filter((item) => item.kind === 'elf-object').length === 2, 'one object should be retained per ASM source');
assert(runner.requests.length === 3, `expected two NASM calls plus one ld call, got ${runner.requests.length}`);

const [firstNasm, secondNasm, linker] = runner.requests;
assert(firstNasm.executable === '/toolchain/bin/nasm', 'NASM tool path must live in the toolchain namespace');
assert(firstNasm.args.join(' ') === '-f elf64 /work/src/000-main.asm -o /work/obj/000-main.o', `unexpected first NASM args: ${firstNasm.args.join(' ')}`);
assert(secondNasm.args.join(' ') === '-f elf64 /work/src/001-helper.asm -o /work/obj/001-helper.o', `unexpected second NASM args: ${secondNasm.args.join(' ')}`);
assert(linker.executable === '/toolchain/bin/ld', 'ld tool path must live in the toolchain namespace');
assert(
  linker.args.join(' ') === '-o /work/build/demo -e _start /work/obj/000-main.o /work/obj/001-helper.o',
  `unexpected ld args: ${linker.args.join(' ')}`
);
assert(linker.files.length === 2, 'linker receives only explicit object files');
assert(linker.files.every((file) => file.path.startsWith('/work/obj/')), 'linker must not receive runtime/global dependencies');

const empty = await backend.assemble({ sources: [] });
assert(!empty.success && empty.diagnostics.some((item) => item.severity === 'error'), 'empty source set should fail before invoking tools');
assert(runner.requests.length === 3, 'empty source validation must not invoke the runner');

console.log('toolchain NASM + ld smoke: PASS (isolated commands + multi-source objects + final artifact)');
