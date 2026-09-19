/**
 * 10Hz clock for collaboration-graph live preview text (the two-line snippet).
 * Status / phase / tool identity stay on the instant Live signature.
 */

import { useSyncExternalStore } from "react";

export const GRAPH_LIVE_PREVIEW_MS = 100;

let tick = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  tick += 1;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (timer == null) {
    timer = setInterval(emit, GRAPH_LIVE_PREVIEW_MS);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getTick(): number {
  return tick;
}

function getZero(): number {
  return 0;
}

function subscribeIdle(_onStoreChange: () => void): () => void {
  return () => {};
}

/** Subscribe only while the face is streaming; settled nodes must not tick. */
export function useGraphLivePreviewTick(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribe : subscribeIdle,
    active ? getTick : getZero,
    getZero,
  );
}
