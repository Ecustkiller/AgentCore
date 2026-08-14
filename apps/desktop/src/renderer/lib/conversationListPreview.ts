import {
  TURN_CANCELLED_EMPTY_MESSAGE,
  TURN_INTERRUPTED_EMPTY_MESSAGE,
  resolveAssistantFailureFace,
  visibleMessageText,
} from "@/lib/errors";
import type { Message } from "@/stores/conversation";

const PREVIEW_SLICE = 80;
const PREVIEW_MAX_CHARS = 80;

/** Rows the list preview may walk; a subset of {@link Message}. */
export type ListPreviewMessage = Pick<
  Message,
  "role" | "content" | "error" | "runs" | "usage" | "finishReason"
>;

function isStopPreview(text: string): boolean {
  const t = text.trim();
  return (
    t === TURN_CANCELLED_EMPTY_MESSAGE || t === TURN_INTERRUPTED_EMPTY_MESSAGE
  );
}

function truncatePreview(text: string, max = PREVIEW_MAX_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

/**
 * Sidebar / opened-cache preview from the trusted window.
 * Never uses a user sentence as the summary. Empty or stop copy (`已停止`)
 * walks back to the previous visible assistant; if none, keep the listed
 * (server) preview until the next hydrate. Empty non-failure on the last
 * assistant still clears rather than keeping a stale success preview.
 * Walk-back is keyed on `finishReason` so paused still skips even if
 * `resolveAssistantFailureFace` later returns null.
 */
export function previewFromOpenedWindow(
  messages: ListPreviewMessage[],
  listedPreview: string | null | undefined,
): string | null {
  if (messages.length === 0) return listedPreview ?? null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row.role === "user") continue;
    const text = visibleMessageText(row);
    if (text) {
      if (isStopPreview(text)) continue;
      return text.slice(0, PREVIEW_SLICE);
    }
    const finishReason = row.finishReason ?? row.runs?.finishReason;
    if (
      finishReason === "cancelled" ||
      finishReason === "paused" ||
      finishReason === "interrupted"
    ) {
      continue;
    }
    const synthetic = resolveAssistantFailureFace({
      content: row.content,
      error: row.error,
      runsError: row.runs?.error,
      usageError: row.usage?.error,
      finishReason,
    });
    if (
      synthetic?.code === "TURN_CANCELLED" ||
      synthetic?.code === "TURN_INTERRUPTED"
    ) {
      continue;
    }
    if (synthetic?.message && isStopPreview(synthetic.message)) continue;
    if (synthetic?.message) return synthetic.message.slice(0, PREVIEW_SLICE);
    // Empty non-failure on the last row: clear (do not keep stale listed preview).
    if (i === messages.length - 1) return null;
  }
  return listedPreview ?? null;
}

/**
 * Tooltip / row preview: listed (server) text is authoritative when it is
 * non-empty and not stop copy. Otherwise walk the opened window for a visible
 * assistant — never concatenate「你:」or fall back to a user sentence.
 */
export function buildMessagePreview(
  lastMessagePreview: string | null | undefined,
  messages: ListPreviewMessage[],
): string | null {
  const listed = lastMessagePreview?.trim() ?? "";
  if (listed && !isStopPreview(listed)) {
    return truncatePreview(listed);
  }
  const walked = previewFromOpenedWindow(messages, null);
  if (!walked || isStopPreview(walked)) return null;
  return truncatePreview(walked);
}
