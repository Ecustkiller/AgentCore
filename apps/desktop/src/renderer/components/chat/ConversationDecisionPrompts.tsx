/**
 * Conversation-level decision prompts shared by chat and canvas 指挥台.
 * Single component path (方案 §3.2 ResumePrompt 单挂载): ChatView and
 * CanvasDecisionPanel both render this — they are mutually exclusive mounts
 * (canvasMode toggle), so only one instance is live at a time.
 */
import { ContextualTipBanner } from "@/components/onboarding/ContextualTip";
import { useConversationStore } from "@/stores/conversation";
import { usePendingApprovals } from "@/stores/interactions";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { DelegationAuthorizationPrompt } from "./DelegationAuthorizationCard";
import { ResumePrompt } from "./ResumePrompt";
import { RunConfirmPrompt } from "./RunConfirmPrompt";

export function ConversationDecisionPrompts() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const pendingResumes = usePausedTurnStore((s) => s.pending);
  const pendingApprovals = usePendingApprovals(conversationId);
  const hasDecisionSurface =
    pendingResumes.some((p) => p.conversationId === conversationId) ||
    pendingApprovals.length > 0;

  return (
    <>
      <ContextualTipBanner tipId="decision_card" active={hasDecisionSurface} />
      <ResumePrompt />
      <DelegationAuthorizationPrompt />
      <ApprovalPrompt />
      <RunConfirmPrompt />
    </>
  );
}
