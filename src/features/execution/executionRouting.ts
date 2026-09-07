import type { LoadedImage } from '../binary/model';
import type { ExecutionSupport } from './model';

/**
 * Normal guest-program routing. This is intentionally independent from the
 * legacy bounded interpreter and from producer/toolchain identity.
 */
export function binaryExecutionSupport(image: LoadedImage): ExecutionSupport {
  const reasons: string[] = [];
  if (image.architecture !== 'x86-64') reasons.push(`Architecture ${image.architecture} is not supported by the current Unicorn x86 runtime.`);
  if (image.kind !== 'executable' && image.kind !== 'pie-executable') {
    reasons.push(`Guest execution accepts ELF executables; image kind is ${image.kind}.`);
  }
  if (!image.segments.some((segment) => segment.executable && image.entry >= segment.virtualAddress && image.entry < segment.virtualAddress + segment.memorySize)) {
    reasons.push(`Entry point 0x${image.entry.toString(16)} is not inside an executable PT_LOAD mapping.`);
  }
  if (reasons.length) return { supported: false, provider: null, reasons, notes: [] };

  const dynamic = image.kind === 'pie-executable' || !!image.interpreter || image.neededLibraries.length > 0;
  return {
    supported: true,
    provider: dynamic ? 'unicorn-linux' : 'unicorn-machine',
    reasons: [],
    notes: dynamic
      ? [
          'Linux ELF will execute in the kernel-less Unicorn/WASM process backend.',
          ...(image.interpreter ? [`PT_INTERP ${image.interpreter} is resolved from the prepared Global Dependency environment.`] : []),
          ...(image.neededLibraries.length ? [`${image.neededLibraries.length} direct DT_NEEDED entr${image.neededLibraries.length === 1 ? 'y' : 'ies'} are resolved recursively from Global Dependencies.`] : [])
        ]
      : ['Static fixed-address ELF will execute directly in the Unicorn/WASM machine backend.']
  };
}
