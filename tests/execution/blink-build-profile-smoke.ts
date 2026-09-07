import {
  BLINK_BUILD_PROFILE_SCHEMA,
  REQUIRED_BLINK_BUILD_PROFILE,
  REQUIRED_BLINK_COMMIT,
  validateBlinkBuildProfile
} from '../../src/features/execution/blinkBuildProfile';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const valid = {
  schema: BLINK_BUILD_PROFILE_SCHEMA,
  profile: REQUIRED_BLINK_BUILD_PROFILE,
  blinkCommit: REQUIRED_BLINK_COMMIT,
  cpu: {
    architecture: 'x86-64',
    isaLevel: 'x86-64-baseline',
    x87: true,
    mmx: true,
    sse: true,
    sse2: true
  },
  build: {
    disableJit: true,
    nonPosixLinuxApis: true,
    headlessSignalRegisters: true
  }
};

const accepted = validateBlinkBuildProfile(valid);
assert(accepted.ok, `baseline Blink profile should be accepted: ${accepted.reason}`);

const oldUpstreamStyle = structuredClone(valid);
oldUpstreamStyle.cpu.x87 = false;
const rejected = validateBlinkBuildProfile(oldUpstreamStyle);
assert(!rejected.ok, 'x87-disabled Blink profile must be rejected');
assert(rejected.reason?.includes('x87=false'), `unexpected rejection reason: ${rejected.reason}`);

const staleCrashCapture = structuredClone(valid);
staleCrashCapture.build.headlessSignalRegisters = false;
const rejectedCrashCapture = validateBlinkBuildProfile(staleCrashCapture);
assert(!rejectedCrashCapture.ok, 'Blink build without headless signal registers must be rejected');
assert(rejectedCrashCapture.reason?.includes('fresh register state'), `unexpected headless-state rejection reason: ${rejectedCrashCapture.reason}`);

const wrongCommit = structuredClone(valid);
wrongCommit.blinkCommit = 'old-prebuilt';
assert(!validateBlinkBuildProfile(wrongCommit).ok, 'stale Blink commit must be rejected');

console.log('blink build profile smoke: PASS (x86-64-baseline + pinned source + headless signal registers)');
