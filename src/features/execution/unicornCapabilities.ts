import type { UnicornEngine, UnicornModule } from './unicornTypes';
import { currentUnicornX86, loadUnicornX86 } from './unicornLoader';

export type UnicornCapabilityId = 'baseline' | 'cpuid' | 'xgetbv' | 'sse2' | 'avx' | 'avx2';

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
  /** Individual probe results only; this report does not certify a full ISA level. */
  scope: 'observed-probes';
  /** Remains null until a complete ISA level is both implemented and validated. */
  completeIsaLevel: null;
  probes: UnicornCapabilityProbe[];
}

type ProbeDefinition = Readonly<{ id: UnicornCapabilityId; label: string; bytes: number[] }>;

const PROBES: ReadonlyArray<ProbeDefinition> = [
  { id: 'baseline', label: 'x86-64 baseline probe', bytes: [0x48, 0xc7, 0xc0, 0x2a, 0x00, 0x00, 0x00] }, // mov rax, 42
  { id: 'cpuid', label: 'CPUID probe', bytes: [0x0f, 0xa2] },
  { id: 'xgetbv', label: 'XGETBV probe', bytes: [0x0f, 0x01, 0xd0] }, // ECX defaults to XCR0
  { id: 'sse2', label: 'SSE2 probe', bytes: [0x66, 0x0f, 0xef, 0xc0] }, // pxor xmm0, xmm0
  { id: 'avx', label: 'AVX 3-operand XOR probe', bytes: [0xc5, 0xf0, 0x57, 0xc2] }, // vxorps xmm0,xmm1,xmm2
  {
    id: 'avx2',
    label: 'AVX2 audited-subset probe (256-bit move + 3-operand XOR; not a full ISA claim)',
    bytes: [0xc5, 0xf5, 0xef, 0xc2] // vpxor ymm0,ymm1,ymm2
  }
];

const PROBE_ADDRESS = 0x100000;
const PROBE_DATA_ADDRESS = 0x110000;
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

function failureDetail(engine: UnicornEngine, module: UnicornModule, cause: unknown): string {
  let detail = cause instanceof Error ? cause.message : String(cause);
  try {
    const errno = engine.errno();
    detail = `${detail} (errno ${errno}: ${module.strerror(errno)})`;
  } catch {
    // The thrown Unicorn error remains enough observed evidence.
  }
  return detail;
}

function expectBytes(actual: Uint8Array, expected: readonly number[], label: string): void {
  if (actual.length !== expected.length) {
    throw new Error(`${label}: expected ${expected.length} bytes, found ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(
        `${label}: byte ${index} expected 0x${expected[index].toString(16).padStart(2, '0')}, ` +
        `found 0x${actual[index].toString(16).padStart(2, '0')}`
      );
    }
  }
}

function runInstructionProbe(module: UnicornModule, probe: ProbeDefinition): UnicornCapabilityProbe {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  try {
    engine.mem_map(PROBE_ADDRESS, PROBE_PAGE_SIZE, module.PROT_ALL);
    engine.mem_write(PROBE_ADDRESS, probe.bytes);
    engine.emu_start(PROBE_ADDRESS, PROBE_ADDRESS + probe.bytes.length, 0, 1);
    return { ...probe, supported: true, error: null };
  } catch (cause) {
    return { ...probe, supported: false, error: failureDetail(engine, module, cause) };
  } finally {
    engine.close();
  }
}

function runVectorXorProbe(
  module: UnicornModule,
  probe: ProbeDefinition,
  width: 16 | 32
): UnicornCapabilityProbe {
  const engine = new module.Unicorn(module.ARCH_X86, module.MODE_64);
  const sourceA = Array.from({ length: width }, (_, index) => index & 0xff);
  const sourceB = Array.from({ length: width }, (_, index) => ((width === 16 ? 0xf0 : 0x80) + index) & 0xff);
  const expected = sourceA.map((value, index) => value ^ sourceB[index]);

  // Keep setup/observation outside the instruction under test whenever possible.
  // AVX uses legacy MOVDQU around a VEX.128 VXORPS so vvvv/three-operand semantics
  // are verified independently of VEX moves. The AVX2 probe necessarily exercises
  // the minimal 256-bit VMOVDQU + VPXOR closure because legacy SSE cannot seed or
  // observe the upper 128-bit YMM lane. Its success is evidence for this subset,
  // not a claim that every AVX2 opcode is implemented.
  const code = width === 16
    ? [
        0xf3, 0x0f, 0x6f, 0x08,
        0xf3, 0x0f, 0x6f, 0x50, 0x10,
        ...probe.bytes,
        0xf3, 0x0f, 0x7f, 0x40, 0x20
      ]
    : [
        0xc5, 0xfe, 0x6f, 0x08,
        0xc5, 0xfe, 0x6f, 0x50, 0x20,
        ...probe.bytes,
        0xc5, 0xfe, 0x7f, 0x40, 0x40
      ];
  const sourceBOffset = width;
  const outputOffset = width * 2;

  try {
    engine.mem_map(PROBE_ADDRESS, PROBE_PAGE_SIZE, module.PROT_ALL);
    engine.mem_map(PROBE_DATA_ADDRESS, PROBE_PAGE_SIZE, module.PROT_READ | module.PROT_WRITE);
    engine.mem_write(PROBE_ADDRESS, code);
    engine.mem_write(PROBE_DATA_ADDRESS, sourceA);
    engine.mem_write(PROBE_DATA_ADDRESS + sourceBOffset, sourceB);
    engine.reg_write_i64(module.X86_REG_RAX, BigInt(PROBE_DATA_ADDRESS));
    engine.emu_start(PROBE_ADDRESS, PROBE_ADDRESS + code.length, 0, 0);
    expectBytes(engine.mem_read(PROBE_DATA_ADDRESS + outputOffset, width), expected, probe.label);
    return { ...probe, supported: true, error: null };
  } catch (cause) {
    return { ...probe, supported: false, error: failureDetail(engine, module, cause) };
  } finally {
    engine.close();
  }
}

function runProbe(module: UnicornModule, probe: ProbeDefinition): UnicornCapabilityProbe {
  if (probe.id === 'avx') return runVectorXorProbe(module, probe, 16);
  if (probe.id === 'avx2') return runVectorXorProbe(module, probe, 32);
  return runInstructionProbe(module, probe);
}

export function probeUnicornModule(module: UnicornModule): UnicornCapabilityReport {
  return {
    version: versionString(module),
    architecture: 'x86-64',
    evidence: 'observed-unicorn-execution',
    scope: 'observed-probes',
    completeIsaLevel: null,
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
