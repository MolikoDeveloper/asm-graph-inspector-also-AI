import { NasmLdAssemblerBackend } from './nasmLdBackend';
import {
  BlinkToolProcessRunner,
  type BlinkToolProcessPolicy,
  type BlinkToolRuntime
} from './blinkToolProcessRunner';
import type { ToolFile } from './toolProcess';

export interface PinnedToolAsset {
  id: 'nasm' | 'ld';
  version: string;
  publicPath: string;
  toolPath: '/toolchain/bin/nasm' | '/toolchain/bin/ld';
  byteLength: number;
  gitBlobSha1: string;
}

export const PINNED_TOOLCHAIN_SOURCE = Object.freeze({
  repository: 'robalb/x86-64-playground',
  commit: 'd617f6a19879157c1debbe0454b6c4cff2ebe094'
});

export const PINNED_NASM_LD_ASSETS: readonly PinnedToolAsset[] = Object.freeze([
  Object.freeze({
    id: 'nasm',
    version: '3.00',
    publicPath: 'vendor/toolchain/nasm.3.00.elf',
    toolPath: '/toolchain/bin/nasm',
    byteLength: 1_808_400,
    gitBlobSha1: '4954233b5edd322f9ec5da4f371d5127eac1e300'
  }),
  Object.freeze({
    id: 'ld',
    version: '2.43.50',
    publicPath: 'vendor/toolchain/gnu-ld.2.43.50.elf',
    toolPath: '/toolchain/bin/ld',
    byteLength: 2_790_840,
    gitBlobSha1: 'c5834047a865bdcaaded2fe878b0b4ead1fb2853'
  })
]);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + bytes.byteLength);
  object.set(header, 0);
  object.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest('SHA-1', object);
  return hex(new Uint8Array(digest));
}

export async function verifyPinnedToolAsset(asset: PinnedToolAsset, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength !== asset.byteLength) {
    throw new Error(`${asset.id} ${asset.version} tool asset has ${bytes.byteLength} bytes; expected ${asset.byteLength}. Run \`bun run vendor:toolchain\`.`);
  }
  const identity = await gitBlobSha1(bytes);
  if (identity !== asset.gitBlobSha1) {
    throw new Error(`${asset.id} ${asset.version} tool asset Git blob identity is ${identity}; expected ${asset.gitBlobSha1}. Run \`bun run vendor:toolchain\`.`);
  }
}

export interface LoadPinnedNasmLdToolchainOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function defaultBaseUrl(): string {
  if (typeof window === 'undefined') throw new Error('Pinned browser toolchain loading requires an explicit baseUrl outside the browser.');
  return new URL(import.meta.env.BASE_URL, window.location.href).href;
}

export async function loadPinnedNasmLdToolchain(
  options: LoadPinnedNasmLdToolchainOptions = {}
): Promise<ToolFile[]> {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const files: ToolFile[] = [];

  for (const asset of PINNED_NASM_LD_ASSETS) {
    const url = new URL(asset.publicPath, baseUrl).href;
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to load ${asset.id} ${asset.version} from ${url} (HTTP ${response.status}). Run \`bun run vendor:toolchain\` and rebuild.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyPinnedToolAsset(asset, bytes);
    files.push({ path: asset.toolPath, bytes, executable: true });
  }

  return files;
}

export interface CreatePinnedNasmLdBackendOptions extends LoadPinnedNasmLdToolchainOptions {
  runtime?: BlinkToolRuntime;
  policy?: Partial<BlinkToolProcessPolicy>;
}

export async function createPinnedNasmLdAssemblerBackend(
  options: CreatePinnedNasmLdBackendOptions = {}
): Promise<NasmLdAssemblerBackend> {
  const toolchainFiles = await loadPinnedNasmLdToolchain(options);
  const runner = new BlinkToolProcessRunner({
    toolchainFiles,
    runtime: options.runtime,
    policy: options.policy
  });
  return new NasmLdAssemblerBackend(runner);
}
