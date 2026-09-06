import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapstoneModule } from '../src/features/capstone/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const capstoneJsPath = resolve(root, 'public/vendor/capstone/capstone_x86.js');
const capstoneWasmPath = resolve(root, 'public/vendor/capstone/capstone_x86.wasm');

export async function loadHeadlessCapstone(): Promise<CapstoneModule> {
  const source = await readFile(capstoneJsPath, 'utf8');
  const moduleBox: { exports: unknown } = { exports: {} };
  const require = createRequire(import.meta.url);
  const evaluate = new Function(
    'module',
    'exports',
    'require',
    '__filename',
    '__dirname',
    `${source}\nreturn module.exports?.default ?? module.exports ?? MCapstone;`
  ) as (module: { exports: unknown }, exports: unknown, require: (specifier: string) => unknown, filename: string, dirname: string) => unknown;
  const factory = evaluate(moduleBox, moduleBox.exports, require, capstoneJsPath, dirname(capstoneJsPath));
  if (typeof factory !== 'function') throw new Error('Vendored Capstone factory could not be evaluated in the headless runtime.');
  const result = await (factory as (options?: { locateFile?: (path: string) => string }) => Promise<CapstoneModule>)({
    locateFile: (path) => path.endsWith('.wasm') ? capstoneWasmPath : path
  });
  return result;
}
