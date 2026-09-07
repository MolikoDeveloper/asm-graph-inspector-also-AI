import type { CapstoneModule } from './types';

export type CapstoneStatus = 'idle' | 'loading' | 'ready' | 'error';

let modulePromise: Promise<CapstoneModule> | null = null;
let loadedModule: CapstoneModule | null = null;

function assetUrl(relative: string): string {
  return new URL(`${import.meta.env.BASE_URL}${relative}`, window.location.href).href;
}

function loadScriptOnce(): Promise<void> {
  if (window.MCapstone) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>('script[data-capstone-x86]');
  if (existing) {
    return new Promise((resolve, reject) => {
      if (window.MCapstone) resolve();
      else {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Capstone JS')), { once: true });
      }
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = assetUrl('vendor/capstone/capstone_x86.js');
    script.async = true;
    script.dataset.capstoneX86 = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Capstone JS'));
    document.head.appendChild(script);
  });
}

export async function loadCapstone(): Promise<CapstoneModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      await loadScriptOnce();
      if (!window.MCapstone) throw new Error('Capstone module factory was not registered');
      const wasmUrl = assetUrl('vendor/capstone/capstone_x86.wasm');
      const module = await window.MCapstone({
        locateFile: (path) => path.endsWith('.wasm') ? wasmUrl : path
      });
      loadedModule = module;
      return module;
    })();
  }
  return modulePromise;
}

/**
 * Returns the already initialized module without starting an async load.
 * Blink process execution always runs the ISA preflight first, so this is
 * available when a headless signal callback needs to decode the exact RIP.
 */
export function currentCapstone(): CapstoneModule | null {
  return loadedModule;
}

export function resetCapstoneLoader(): void {
  modulePromise = null;
  loadedModule = null;
}
