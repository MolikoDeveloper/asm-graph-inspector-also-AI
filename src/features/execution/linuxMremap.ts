export const MREMAP_MAYMOVE = 0x1;
export const MREMAP_FIXED = 0x2;
export const MREMAP_DONTUNMAP = 0x4;

export type LinuxMremapShape =
  | { kind: 'invalid' }
  | { kind: 'same'; oldSpan: number; newSpan: number; mayMove: boolean }
  | { kind: 'shrink'; oldSpan: number; newSpan: number; mayMove: boolean }
  | { kind: 'grow'; oldSpan: number; newSpan: number; mayMove: boolean };

export type LinuxMremapPlacement =
  | { kind: 'same-address' }
  | { kind: 'move'; address: number }
  | { kind: 'no-memory' };

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

export function planLinuxMremapShape(
  oldAddress: number,
  oldSize: number,
  newSize: number,
  flags: number,
  pageSize: number
): LinuxMremapShape {
  if (!Number.isSafeInteger(oldAddress) || !Number.isSafeInteger(oldSize) || !Number.isSafeInteger(newSize)) return { kind: 'invalid' };
  if (oldAddress < 0 || oldSize <= 0 || newSize <= 0 || pageSize <= 0 || oldAddress % pageSize !== 0) return { kind: 'invalid' };
  if ((flags & ~MREMAP_MAYMOVE) !== 0) return { kind: 'invalid' };
  const oldSpan = alignUp(oldSize, pageSize);
  const newSpan = alignUp(newSize, pageSize);
  const mayMove = (flags & MREMAP_MAYMOVE) !== 0;
  if (newSpan === oldSpan) return { kind: 'same', oldSpan, newSpan, mayMove };
  if (newSpan < oldSpan) return { kind: 'shrink', oldSpan, newSpan, mayMove };
  return { kind: 'grow', oldSpan, newSpan, mayMove };
}

export function chooseLinuxMremapPlacement(
  shape: LinuxMremapShape,
  canGrowInPlace: boolean,
  moveAddress: number | null
): LinuxMremapPlacement {
  if (shape.kind === 'invalid') return { kind: 'no-memory' };
  if (shape.kind !== 'grow' || canGrowInPlace) return { kind: 'same-address' };
  if (shape.mayMove && moveAddress !== null) return { kind: 'move', address: moveAddress };
  return { kind: 'no-memory' };
}
