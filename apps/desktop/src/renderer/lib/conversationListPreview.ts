/**
 * Sidebar list `lastMessagePreview` derivation — shared by the RQ conversation
 * cache sync and the offline opened-cache writer.
 */
import {
  syntheticErrorForEmptyFailure,
  visibleMessageText,
} from "@/lib/errors";
import type { Message } from "@/stores/conversation";

const PREVIEW_SLICE = 80;

/**
 * Sidebar / opened-cache preview from the trusted window's last row.
 * When the last row exists but has no visible text, never keep a stale list
 * preview — prefer the same synthetic empty-failure face as the message bubble,
 * except user-stop (`cancelled`): chat timeline no longer shows「已停止」, so
 * walk back for prior visible text (else clear).
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
    const synthetic = syntheticErrorForEmptyFailure(
      finishReason,
      row.runs?.error?.code,
    );
    if (synthetic?.code === "TURN_CANCELLED") continue;
    if (synthetic?.message) return synthetic.message.slice(0, PREVIEW_SLICE);
    // Empty non-failure on the last row: clear (do not keep stale listed preview).
    if (i === messages.length - 1) return null;
  }
  return null;
}
