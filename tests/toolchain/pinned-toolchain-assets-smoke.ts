import {
  PINNED_NASM_LD_ASSETS,
  PINNED_TOOLCHAIN_SOURCE,
  gitBlobSha1,
  verifyPinnedToolAsset
} from '../../src/features/toolchain/pinnedNasmLdToolchain';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const hello = new TextEncoder().encode('hello');
assert(
  await gitBlobSha1(hello) === 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0',
  'Git blob SHA-1 framing must match Git object identity semantics'
);

assert(PINNED_TOOLCHAIN_SOURCE.commit.length === 40, 'toolchain source must be pinned to a full commit SHA');
assert(PINNED_NASM_LD_ASSETS.length === 2, 'NASM + ld profile should contain exactly two tool assets');
assert(PINNED_NASM_LD_ASSETS[0].toolPath === '/toolchain/bin/nasm', 'NASM path must stay in /toolchain');
assert(PINNED_NASM_LD_ASSETS[1].toolPath === '/toolchain/bin/ld', 'GNU ld path must stay in /toolchain');
assert(PINNED_NASM_LD_ASSETS.every((asset) => asset.byteLength > 0 && asset.gitBlobSha1.length === 40), 'pinned assets need size + Git blob identity');

const synthetic = {
  id: 'nasm' as const,
  version: 'fixture',
  publicPath: 'fixture',
  toolPath: '/toolchain/bin/nasm' as const,
  byteLength: hello.byteLength,
  gitBlobSha1: 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
};
await verifyPinnedToolAsset(synthetic, hello);

let mismatchRejected = false;
try {
  await verifyPinnedToolAsset(synthetic, new TextEncoder().encode('HELLO'));
} catch {
  mismatchRejected = true;
}
assert(mismatchRejected, 'modified tool bytes must fail pinned identity validation');

console.log('pinned toolchain asset smoke: PASS (full source pin + Git blob byte identity)');
