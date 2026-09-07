export const BLINK_BUILD_PROFILE_SCHEMA = 'asm-graph.blink-build-profile/v1';
export const REQUIRED_BLINK_BUILD_PROFILE = 'asm-graph-inspector-linux-x86-64-baseline-v1';
export const REQUIRED_BLINK_COMMIT = '71487ee40869b3ccac6cac9bb7a45d71484978d6';

export interface BlinkBuildProfile {
  schema: typeof BLINK_BUILD_PROFILE_SCHEMA;
  profile: typeof REQUIRED_BLINK_BUILD_PROFILE;
  blinkCommit: string;
  cpu: {
    architecture: 'x86-64';
    isaLevel: 'x86-64-baseline';
    x87: true;
    mmx: true;
    sse: true;
    sse2: true;
  };
  build: {
    disableJit: true;
    nonPosixLinuxApis: true;
    headlessSignalRegisters: true;
    headlessSignalCodeBytes: true;
  };
  artifacts?: {
    jsSha256?: string;
    wasmSha256?: string;
  };
}

export interface BlinkBuildProfileValidation {
  ok: boolean;
  reason: string | null;
  profile: BlinkBuildProfile | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validateBlinkBuildProfile(value: unknown): BlinkBuildProfileValidation {
  const root = record(value);
  if (!root) return { ok: false, reason: 'Blink build profile is not an object.', profile: null };
  if (root.schema !== BLINK_BUILD_PROFILE_SCHEMA) {
    return { ok: false, reason: `Blink build profile schema is unsupported (${String(root.schema ?? 'missing')}).`, profile: null };
  }
  if (root.profile !== REQUIRED_BLINK_BUILD_PROFILE) {
    return { ok: false, reason: `Blink build profile is ${String(root.profile ?? 'missing')}; expected ${REQUIRED_BLINK_BUILD_PROFILE}.`, profile: null };
  }
  if (root.blinkCommit !== REQUIRED_BLINK_COMMIT) {
    return { ok: false, reason: `Blink source commit is ${String(root.blinkCommit ?? 'missing')}; expected ${REQUIRED_BLINK_COMMIT}.`, profile: null };
  }

  const cpu = record(root.cpu);
  if (!cpu) return { ok: false, reason: 'Blink build profile is missing CPU capabilities.', profile: null };
  const requiredCpu: Array<[string, unknown]> = [
    ['architecture', 'x86-64'],
    ['isaLevel', 'x86-64-baseline'],
    ['x87', true],
    ['mmx', true],
    ['sse', true],
    ['sse2', true]
  ];
  for (const [field, expected] of requiredCpu) {
    if (cpu[field] !== expected) {
      return { ok: false, reason: `Blink CPU profile ${field}=${String(cpu[field])}; expected ${String(expected)}.`, profile: null };
    }
  }

  const build = record(root.build);
  if (!build) return { ok: false, reason: 'Blink build profile is missing build capabilities.', profile: null };
  if (build.disableJit !== true) return { ok: false, reason: 'Blink browser build must explicitly disable JIT.', profile: null };
  if (build.nonPosixLinuxApis !== true) return { ok: false, reason: 'Blink browser build must keep Linux non-POSIX APIs enabled for glibc process startup.', profile: null };
  if (build.headlessSignalRegisters !== true) return { ok: false, reason: 'Blink browser build must publish fresh register state for headless Run signals/preemptions.', profile: null };
  if (build.headlessSignalCodeBytes !== true) return { ok: false, reason: 'Blink browser build must publish guest code bytes at the observed headless signal RIP without enabling the internal disassembler.', profile: null };

  return { ok: true, reason: null, profile: value as BlinkBuildProfile };
}
