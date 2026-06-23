import type { SSEEvent } from "@/types/events";
import { useSyncExternalStore } from "react";

/**
 * Local (per-machine) preview recordings, captured from real turns via
 * `preview/recorder` and persisted in localStorage. They sit alongside the
 * committed conformance vectors (`preview/fixtures`) in `#/preview`, but are NOT
 * version-controlled: they exist only so a developer can eyeball / screenshot a
 * brand-new AI state right after capturing it. Promote a keeper into a real
 * fixture via the backend export pipeline (`agentcore.conformance.export`); these
 * are scratch.
 */

export interface PreviewRecording {
  name: string;
  description: string;
  events: SSEEvent[];
  /** ISO timestamp; also the sort key (newest first). */
  recordedAt: string;
}

const KEY = "agentcore.preview.recordings.v1";
const CHANGED_EVENT = "preview-recordings-changed";
/** Keep only the newest few so a forgotten record toggle can't fill localStorage. */
const MAX_RECORDINGS = 20;

function readRaw(): PreviewRecording[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PreviewRecording[]) : [];
  } catch {
    return [];
  }
}

// Cached sorted snapshot for useSyncExternalStore (stable ref until invalidated).
let cache: PreviewRecording[] | null = null;

function invalidate(): void {
  cache = null;
}

function commit(list: PreviewRecording[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
  invalidate();
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** All recordings, newest first. */
export function listRecordings(): PreviewRecording[] {
  if (cache === null) {
    cache = readRaw().sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }
  return cache;
}

/**
 * Persist a recording (replacing any with the same name), capped at the newest
 * {@link MAX_RECORDINGS}. Throws on a localStorage quota error so the caller can
 * surface it.
 */
export function saveRecording(rec: PreviewRecording): void {
  const next = [rec, ...readRaw().filter((r) => r.name !== rec.name)]
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, MAX_RECORDINGS);
  commit(next);
}

export function deleteRecording(name: string): void {
  commit(readRaw().filter((r) => r.name !== name));
}

function subscribe(onChange: () => void): () => void {
  const handler = () => {
    invalidate();
    onChange();
  };
  // CHANGED_EVENT fires for same-tab writes; `storage` covers another window.
  window.addEventListener(CHANGED_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGED_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

/** React binding so `#/preview` shows a just-saved recording immediately. */
export function useRecordings(): PreviewRecording[] {
  return useSyncExternalStore(subscribe, listRecordings, listRecordings);
}
