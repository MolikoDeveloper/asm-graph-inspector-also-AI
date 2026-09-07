import type { UnicornModule } from './unicornTypes';
import { currentUnicornX86, loadUnicornX86 } from './unicornLoader';

export type UnicornCapabilityId = 'baseline' | 'sse2' | 'avx' | 'avx2';

export interface UnicornCapabilityProbe {
  id: UnicornCapabilityId;
  label: string;
  supported: boolean;
  bytes: number[];
  error: string | null;
}

export interface UnicornCapabilityReport {
  version: string;
  architecture: 'x86-64';
  evidence: 'observed-unicorn-execution';
  probes: UnicornCapabilityProbe[];
}

const PROBES: ReadonlyArray<{ id: UnicornCapabilityId; label: string; bytes: number[] }> = [
  { id: 'baseline', label: 'x86-64 baseline', bytes: [0x48, 0xc7, 0xc0, 0x2a, 0x00, 0x00, 0x00] }, // mov rax, 42
  { id: 'sse2', label: 'SSE2', bytes: [0x66, 0x0f, 0xef, 0xc0] }, // pxor xmm0, xmm0
  { id: 'avx', label: 'AVX', bytes: [0xc5, 0xf8, 0x57, 0xc0] }, // vxorps xmm0, xmm0, xmm0
  { id: 'avx2', label: 'AVX2', bytes: [0xc5, 0xfd, 0xef, 0xc0] } // vpxor ymm0, ymm0, ymm0
];

const PROBE_ADDRESS = 0x100000;
const PROBE_PAGE_SIZE = 4096;

function versionString(module: UnicornModule): string {
  const packed = module.version();
  if (!Number.isFinite(packed)) return String(packed);
  const major = (packed >>> 24) & 0xff;
  const minor = (packed >>> 16) & 0xff;
  const patch = (packed >>> 8) & 0xff;
  if (major || minor || patch) return `${major}.${minor}.${patch}`;
  return `0x${packed.toString(16)}`;
}

function runProbe(module: UnicornModule, probe: typeof PROBES[number]): UnicornCapabilityProbe {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  try {
    engine.mem_map(PROBE_ADDRESS, PROBE_PAGE_SIZE, module.PROT_ALL);
    engine.mem_write(PROBE_ADDRESS, probe.bytes);
    engine.emu_start(PROBE_ADDRESS, PROBE_ADDRESS + probe.bytes.length, 0, 1);
    return { ...probe, supported: true, error: null };
  } catch (cause) {
    let detail = cause instanceof Error ? cause.message : String(cause);
    try {
      const errno = engine.errno();
      detail = `${detail} (errno ${errno}: ${module.strerror(errno)})`;
    } catch {
      // The thrown Unicorn error remains enough observed evidence.
    }
    return { ...probe, supported: false, error: detail };
  } finally {
    engine.close();
  }
}

export function probeUnicornModule(module: UnicornModule): UnicornCapabilityReport {
  return {
    version: versionString(module),
    architecture: 'x86-64',
    evidence: 'observed-unicorn-execution',
    probes: PROBES.map((probe) => runProbe(module, probe))
  };
}

let cachedReport: UnicornCapabilityReport | null = null;

export function currentUnicornCapabilityReport(): UnicornCapabilityReport | null {
  return cachedReport;
}

export async function probeUnicornX86Capabilities(force = false): Promise<UnicornCapabilityReport> {
  if (!force && cachedReport) return cachedReport;
  const module = currentUnicornX86() ?? await loadUnicornX86();
  cachedReport = probeUnicornModule(module);
  return cachedReport;
}

export function resetUnicornCapabilityReport(): void {
  cachedReport = null;
}
