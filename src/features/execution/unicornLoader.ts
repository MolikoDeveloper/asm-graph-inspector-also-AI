import type { UnicornFactory, UnicornModule } from './unicornTypes';

export type UnicornRuntimeStatus = 'idle' | 'loading' | 'ready' | 'error';

type UnicornWindow = Window & typeof globalThis & { MUnicorn?: UnicornFactory };

let modulePromise: Promise<UnicornModule> | null = null;
let loadedModule: UnicornModule | null = null;

function assetUrl(relative: string): string {
  return new URL(`${import.meta.env.BASE_URL}${relative}`, window.location.href).href;
}

function unicornWindow(): UnicornWindow {
  return window as UnicornWindow;
}

function loadScriptOnce(): Promise<void> {
  if (unicornWindow().MUnicorn) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>('script[data-unicorn-x86]');
  if (existing) {
    return new Promise((resolve, reject) => {
      if (unicornWindow().MUnicorn) resolve();
      else {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Unicorn x86 runtime')), { once: true });
      }
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = assetUrl('vendor/unicorn/unicorn_x86.js');
    script.async = true;
    script.dataset.unicornX86 = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Unicorn x86 runtime'));
    document.head.appendChild(script);
  });
}

export async function loadUnicornX86(): Promise<UnicornModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      await loadScriptOnce();
      const factory = unicornWindow().MUnicorn;
      if (!factory) throw new Error('Unicorn module factory was not registered');
      const module = await factory();
      if (!module.arch_supported(module.ARCH_X86)) throw new Error('Vendored Unicorn runtime does not contain x86 support');
      loadedModule = module;
      return module;
    })();
  }
  return modulePromise;
}

export function currentUnicornX86(): UnicornModule | null {
  return loadedModule;
}

export function resetUnicornLoader(): void {
  modulePromise = null;
  loadedModule = null;
}
