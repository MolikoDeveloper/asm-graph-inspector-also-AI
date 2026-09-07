import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseElfImage, executableBytesForRange } from '../../src/features/binary/elfParser';
import { decodeX86_64 } from '../../src/features/capstone/capstoneDecoder';
import { blinkUnsupportedIsaFamily } from '../../src/features/execution/blinkIsaPreflight';
import { loadHeadlessCapstone } from '../../scripts/headless-capstone';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runTool(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed with ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const nasmPath = resolve(root, 'public/vendor/toolchain/nasm.3.00.elf');
const ldPath = resolve(root, 'public/vendor/toolchain/gnu-ld.2.43.50.elf');
const sourcePath = resolve(root, 'tests/toolchain/fixtures/unsupported-avx.asm');
const work = await mkdtemp(resolve(tmpdir(), 'asm-graph-avx-preflight-'));

try {
  const objectPath = resolve(work, 'unsupported-avx.o');
  const executablePath = resolve(work, 'unsupported-avx');
  runTool(nasmPath, ['-f', 'elf64', sourcePath, '-o', objectPath]);
  runTool(ldPath, ['-o', executablePath, '-e', '_start', objectPath]);

  const buffer = exactArrayBuffer(new Uint8Array(await readFile(executablePath)));
  const image = parseElfImage('fixture:avx', executablePath, buffer);
  const capstone = await loadHeadlessCapstone();
  const unsupported: Array<{ address: number; mnemonic: string; family: string }> = [];

  for (const segment of image.segments.filter((candidate) => candidate.executable && candidate.fileSize > 0)) {
    const bytes = executableBytesForRange(image, buffer, segment.virtualAddress, segment.fileSize);
    for (const instruction of decodeX86_64(capstone, bytes, segment.virtualAddress, { maxInstructions: 4096 })) {
      const family = blinkUnsupportedIsaFamily({ bytes: instruction.bytes, mnemonic: instruction.mnemonic });
      if (family) unsupported.push({ address: instruction.address, mnemonic: instruction.mnemonic, family });
    }
  }

  assert(unsupported.length >= 2, `real AVX fixture should expose unsupported instructions, got ${JSON.stringify(unsupported)}`);
  assert(unsupported[0]?.address === image.entry, `first unsupported instruction should be ELF entry 0x${image.entry.toString(16)}`);
  assert(unsupported[0]?.mnemonic === 'vbroadcastss', `expected vbroadcastss at entry, got ${unsupported[0]?.mnemonic ?? 'none'}`);
  assert(unsupported[0]?.family === 'avx-family', `expected AVX family, got ${unsupported[0]?.family ?? 'none'}`);
  assert(unsupported.some((instruction) => instruction.mnemonic === 'vzeroupper'), 'real fixture should also detect vzeroupper');

  console.log(`real AVX ELF preflight smoke: PASS (first unsupported 0x${unsupported[0].address.toString(16)} ${unsupported[0].mnemonic})`);
} finally {
  await rm(work, { recursive: true, force: true });
}
