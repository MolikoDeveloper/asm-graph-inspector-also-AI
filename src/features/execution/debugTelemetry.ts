export interface DebugLogEntryLike {
  time: number;
  level: 'info' | 'success' | 'error' | 'muted';
  message: string;
}

export interface AssemblyBuildTelemetry {
  status: 'idle' | 'building' | 'success' | 'error' | 'reused';
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  message: string | null;
}

function isBuildStart(message: string): boolean {
  return message.startsWith('Preparing real ELF for ') || (message.startsWith('Assembling ') && message.includes('pinned NASM + GNU ld'));
}

function completionStatus(message: string): AssemblyBuildTelemetry['status'] | null {
  if (message.startsWith('Reusing fresh ')) return 'reused';
  if (message.startsWith('Built ')) return 'success';
  if (message.startsWith('ASM execution build failed:') || message.startsWith('ASM build failed:') || message.startsWith('ASM build failed for ')) return 'error';
  return null;
}

export function deriveAssemblyBuildTelemetry(entries: readonly DebugLogEntryLike[], now = Date.now()): AssemblyBuildTelemetry {
  let startIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isBuildStart(entries[index].message)) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) return { status: 'idle', startedAt: null, endedAt: null, elapsedMs: null, message: null };

  const start = entries[startIndex];
  for (let index = startIndex + 1; index < entries.length; index += 1) {
    const status = completionStatus(entries[index].message);
    if (!status) continue;
    return {
      status,
      startedAt: start.time,
      endedAt: entries[index].time,
      elapsedMs: Math.max(0, entries[index].time - start.time),
      message: entries[index].message
    };
  }

  return {
    status: 'building',
    startedAt: start.time,
    endedAt: null,
    elapsedMs: Math.max(0, now - start.time),
    message: start.message
  };
}
