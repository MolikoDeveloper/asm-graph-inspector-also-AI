import { useSyncExternalStore } from 'react';
import { idleBlinkIsaPreflight, type BlinkIsaPreflightState } from './blinkIsaPreflight';

let current = idleBlinkIsaPreflight();
const listeners = new Set<() => void>();

export function publishBlinkIsaPreflight(state: BlinkIsaPreflightState): void {
  current = state;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): BlinkIsaPreflightState {
  return current;
}

export function useBlinkIsaPreflightMonitor(): BlinkIsaPreflightState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
