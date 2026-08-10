import { useConversationStore } from "@/stores/conversation";
import { QueuedTurnsBar } from "./QueuedTurnsBar";
import {
  TurnComposer,
  type TurnComposerVariant,
} from "./message-input/TurnComposer";

/**
 * The chat view's composer: the unified {@link TurnComposer} in its chat chrome
 * (bottom padding, default placeholder). The canvas 命令栏
 * ({@link import("../graph/CanvasCommandBar").CanvasCommandBar}) is the SAME core in
 * canvas chrome — one composer, two skins, single draft per conversation.
 *
 * `variant` is chosen by ChatView: `bar` for the session bottom dock（＋收纳配置）,
 * `card` for the centered new-chat composer. Canvas keeps its own full card.
 *
 * Workspace / Git / compose actions live inside TurnComposer. When fused under
 * ApprovalPrompt, ChatView stacks ApprovalPrompt above this input so the
 * 一体圆角不受打断.
 */
export function MessageInput({
  className,
  variant = "card",
  attachedBelowApproval = false,
}: {
  className?: string;
  variant?: TurnComposerVariant;
  /** Flush under ApprovalPrompt in the bottom-bar 一体态. */
  attachedBelowApproval?: boolean;
}) {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  return (
    <div className={className ?? "px-4 pb-4 pt-2"}>
      <QueuedTurnsBar conversationId={conversationId} />
      <TurnComposer
        variant={variant}
        attachedBelowApproval={attachedBelowApproval}
      />
    </div>
  );
}
