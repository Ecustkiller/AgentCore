/**
 * Session-field badge above the composer: what happened to this chat's earlier turns.
 *
 * Two states on one grey line, both flag-only — neither ever shows summary text, and
 * neither is a card:
 *
 * - **压缩成功** (`show`, from `context_compacted`) — the one-liner「较早对话已压缩」.
 * - **压缩没跟上** (`context_gap`) — folding kept failing until the chat outgrew its
 *   window, so the model really is answering without its early turns. Reported even
 *   when `show` is false: a chat that never got a single summary written is exactly
 *   the shape that day-long production failure took, and it is the one that most
 *   needs saying out loud.
 *
 * The gap is read here rather than taken as a prop so the composer keeps passing only
 * the flag it always did. Degradation stays grey, never a red card: nothing failed for
 * the user's turn and nothing was deleted — see `composerContextGapHint` for the
 * honesty bar the copy has to clear.
 */
import { useConversations } from "@/hooks/useConversations";
import {
  COMPOSER_CONTEXT_COMPACTED_HINT,
  composerContextGapHint,
} from "@/lib/composerContextCompactedHint";
import { useConversationStore } from "@/stores/conversation";

export function ComposerContextCompactedHint({ show }: { show: boolean }) {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const conversations = useConversations();
  const gapHint = composerContextGapHint(
    conversationId
      ? conversations.find((c) => c.id === conversationId)?.contextGap
      : undefined,
  );

  if (gapHint) {
    return (
      <div
        aria-live="polite"
        data-testid="composer-context-gap-hint"
        className="flex items-start gap-1.5 px-4 pt-2 text-xs text-muted-foreground"
      >
        {gapHint}
      </div>
    );
  }

  if (!show) return null;
  return (
    <div
      aria-live="polite"
      data-testid="composer-context-compacted-hint"
      className="flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground"
    >
      {COMPOSER_CONTEXT_COMPACTED_HINT}
    </div>
  );
}
