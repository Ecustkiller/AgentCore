import type { SSEEvent } from "@/types/events";
import { useSyncExternalStore } from "react";

/**
 * Live-turn recorder for the offline preview (`#/preview`). When armed for a real
 * conversation it taps the single SSE dispatch (`services/sse/dispatch`) and
 * buffers every event of that conversation's turn(s); stopping hands the buffer
 * back so the UI can persist it (`preview/recordings`). This fills the preview's
 * one blind spot: a brand-new AI state — one not yet exported as a committed
 * conformance vector — can be captured from a single real turn and replayed
 * offline immediately, without re-running the backend or the export pipeline.
 *
 * Replays are never recorded: the preview replay path dispatches under `preview-*`
 * conversation ids, which can never equal the armed *real* id.
 */

let armedConvId: string | null = null;
let buffer: SSEEvent[] = [];
const listeners = new Set<() => void>();

export interface RecorderState {
  recording: boolean;
  conversationId: string | null;
  count: number;
}

// Cached snapshot so useSyncExternalStore gets a stable reference between changes
// (a fresh object each read would loop it). Recomputed only on mutation.
let snapshot: RecorderState = {
  recording: false,
  conversationId: null,
  count: 0,
};

function emit(): void {
  snapshot = {
    recording: armedConvId !== null,
    conversationId: armedConvId,
    count: buffer.length,
  };
  for (const listener of listeners) listener();
}

/**
 * Tap called for every dispatched SSE event (live + replay). No-op unless armed
 * for this exact conversation, so replays (`preview-*`) and other conversations
 * are ignored — a single cheap comparison when idle. Captured events are cloned
 * so later store mutations can't corrupt the recording and the buffer stays
 * JSON-serializable for localStorage.
 */
export function captureSSEEvent(event: SSEEvent, conversationId: string): void {
  if (armedConvId === null || conversationId !== armedConvId) return;
  buffer.push(structuredClone(event));
  emit();
}

/** Arm the recorder for a real conversation; clears any prior buffer. */
export function startRecording(conversationId: string): void {
  armedConvId = conversationId;
  buffer = [];
  emit();
}

/** Disarm and return the captured events (buffer is cleared). */
export function stopRecording(): SSEEvent[] {
  const events = buffer;
  armedConvId = null;
  buffer = [];
  emit();
  return events;
}

/** Disarm and discard the buffer without returning it. */
export function cancelRecording(): void {
  armedConvId = null;
  buffer = [];
  emit();
}

export function getRecorderState(): RecorderState {
  return snapshot;
}

export function subscribeRecorder(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding for the record button (live recording flag + event count). */
export function useRecorderState(): RecorderState {
  return useSyncExternalStore(
    subscribeRecorder,
    getRecorderState,
    getRecorderState,
  );
}
