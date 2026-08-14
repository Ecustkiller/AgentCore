import { resolveAssistantFailureFace, visibleMessageText } from "@/lib/errors";
import type { Message } from "@/stores/conversation";

const PREVIEW_SLICE = 80;

/**
 * Sidebar / opened-cache preview from the trusted window's last row.
 * When the last row exists but has no visible text, never keep a stale list
 * preview — prefer the same synthetic empty-failure face as the message bubble,
 * except user-stop (`cancelled`) and pause (`paused`): those empty bubbles
 * walk back for prior visible text (usually the user turn; else clear).
 * Walk-back is keyed on `finishReason` so paused still skips even if
 * `resolveAssistantFailureFace` later returns null (otherwise last-row empty
 * would only clear the preview).
 */
export function previewFromOpenedWindow(
  messages: Message[],
  listedPreview: string | null | undefined,
): string | null {
  if (messages.length === 0) return listedPreview ?? null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    const text = visibleMessageText(row);
    if (text) return text.slice(0, PREVIEW_SLICE);
    const finishReason = row.finishReason ?? row.runs?.finishReason;
    if (finishReason === "cancelled" || finishReason === "paused") continue;
    const synthetic = resolveAssistantFailureFace({
      content: row.content,
      error: row.error,
      runsError: row.runs?.error,
      usageError: row.usage?.error,
      finishReason,
    });
    if (synthetic?.code === "TURN_CANCELLED") continue;
    if (synthetic?.message) return synthetic.message.slice(0, PREVIEW_SLICE);
    // Empty non-failure on the last row: clear (do not keep stale listed preview).
    if (i === messages.length - 1) return null;
  }
  return null;
}
