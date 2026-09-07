import { RuntimeImageResolver, type RuntimeImageCandidate } from '../../src/features/execution/runtimeImageResolver';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function candidate(
  id: string,
  name: string,
  role: RuntimeImageCandidate['role'],
  virtualAddress: number,
  codeOffset: number,
  code: number[]
): RuntimeImageCandidate {
  const bytes = new Uint8Array(256);
  bytes.fill(0x90);
  bytes.set(code, codeOffset);
  return {
    id,
    name,
    role,
    bytes,
    segments: [{
      offset: 0,
      virtualAddress,
      fileSize: bytes.length,
      memorySize: bytes.length,
      executable: true
    }]
  };
}

function line(address: bigint, bytes: number[], assembly: string): string {
  const addressText = address.toString(16).padStart(16, '0');
  const byteText = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  return `<td class="addr">${addressText}</td><td class="hex">${byteText}</td><td class="str">${assembly}</td>`;
}

const programCode = [0x48, 0x31, 0xc0, 0x48, 0xff, 0xc0, 0xc3];
const program = candidate('program', 'program', 'program', 0x400000, 0x20, programCode);
const programRip = 0x400020n;
const programLines = [
  line(programRip, [0x48, 0x31, 0xc0], 'xor rax, rax'),
  line(programRip + 3n, [0x48, 0xff, 0xc0], 'inc rax'),
  line(programRip + 6n, [0xc3], 'ret')
];
const fixedResolver = new RuntimeImageResolver([program], new Map([['program', 0n]]));
const fixed = fixedResolver.resolve(programLines, programRip, 0);
assert(fixed, 'fixed-address program image should resolve');
assertEqual(fixed.name, 'program', 'fixed program name');
assertEqual(fixed.role, 'program', 'fixed program role');
assertEqual(fixed.imageAddress, programRip, 'fixed program image address');
assertEqual(fixed.loadBias, 0n, 'fixed program load bias');
assertEqual(fixed.confidence, 'fixed-address', 'fixed program confidence');

const dependencyCode = [0x55, 0x48, 0x89, 0xe5, 0x48, 0x83, 0xec, 0x10, 0x90, 0xc3, 0x66, 0x90, 0x90, 0x90, 0x90];
const dependency = candidate('libc', 'libc.so.6', 'dependency', 0x1000, 0x30, dependencyCode);
const dependencyBias = 0x7f00_0000_0000n;
const dependencyImageRip = 0x1030n;
const dependencyRip = dependencyBias + dependencyImageRip;
const dependencyLines = [
  line(dependencyRip, [0x55], 'push rbp'),
  line(dependencyRip + 1n, [0x48, 0x89, 0xe5], 'mov rbp, rsp'),
  line(dependencyRip + 4n, [0x48, 0x83, 0xec, 0x10], 'sub rsp, 0x10'),
  line(dependencyRip + 8n, [0x90], 'nop'),
  line(dependencyRip + 9n, [0xc3], 'ret')
];
const dynamicResolver = new RuntimeImageResolver([program, dependency], new Map([['program', 0n]]));
const discovered = dynamicResolver.resolve(dependencyLines, dependencyRip, 0);
assert(discovered, 'dependency image should resolve from a multi-instruction byte signature');
assertEqual(discovered.candidateId, 'libc', 'discovered dependency id');
assertEqual(discovered.name, 'libc.so.6', 'discovered dependency name');
assertEqual(discovered.role, 'dependency', 'discovered dependency role');
assertEqual(discovered.imageAddress, dependencyImageRip, 'discovered dependency image address');
assertEqual(discovered.loadBias, dependencyBias, 'discovered dependency load bias');
assertEqual(discovered.confidence, 'signature', 'discovered dependency confidence');
assert(discovered.signatureBytes >= 8, `dependency signature should use neighbouring instructions, got ${discovered.signatureBytes} bytes`);
assertEqual(dynamicResolver.knownLoadBias('libc'), dependencyBias, 'dependency bias cache');

const cached = dynamicResolver.resolve(dependencyLines, dependencyRip + 1n, 1);
assert(cached, 'cached dependency bias should resolve the next RIP');
assertEqual(cached.imageAddress, dependencyImageRip + 1n, 'cached dependency image address');
assertEqual(cached.confidence, 'cached-signature', 'cached dependency confidence');

const observedResolver = new RuntimeImageResolver([program, dependency], new Map([['program', 0n]]));
const observedBytes = dependency.bytes.slice(0x30, 0x30 + 15);
const observed = observedResolver.resolveBytes(dependencyRip, observedBytes);
assert(observed, 'headless observed bytes should identify a relocated dependency');
assertEqual(observed.name, 'libc.so.6', 'observed dependency name');
assertEqual(observed.imageAddress, dependencyImageRip, 'observed dependency image address');
assertEqual(observed.loadBias, dependencyBias, 'observed dependency load bias');
assertEqual(observed.confidence, 'signature', 'observed dependency confidence');
assertEqual(observed.signatureBytes, 15, 'observed signature byte count');

const ambiguousA = candidate('ambiguous-a', 'libA.so', 'dependency', 0x2000, 0x40, dependencyCode);
const ambiguousB = candidate('ambiguous-b', 'libB.so', 'dependency', 0x3000, 0x40, dependencyCode);
const ambiguousBias = 0x7f10_0000_0000n;
const ambiguousRip = ambiguousBias + 0x2040n;
const ambiguousLines = [
  line(ambiguousRip, [0x55], 'push rbp'),
  line(ambiguousRip + 1n, [0x48, 0x89, 0xe5], 'mov rbp, rsp'),
  line(ambiguousRip + 4n, [0x48, 0x83, 0xec, 0x10], 'sub rsp, 0x10')
];
const ambiguousResolver = new RuntimeImageResolver([ambiguousA, ambiguousB]);
const ambiguous = ambiguousResolver.resolve(ambiguousLines, ambiguousRip, 0);
assertEqual(ambiguous, null, 'ambiguous debugger byte signature must fail closed');
const ambiguousObserved = ambiguousResolver.resolveBytes(ambiguousRip, ambiguousA.bytes.slice(0x40, 0x40 + 15));
assertEqual(ambiguousObserved, null, 'ambiguous observed byte signature must fail closed');

console.log('runtime image resolver smoke: PASS (fixed ET_EXEC + debugger/observed signatures + cached lookup + ambiguity fail-closed)');
