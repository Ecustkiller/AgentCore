/**
 * Conversation-level decision prompts shared by chat and canvas 指挥台.
 * Unified DecisionCard shell; mounts above the composer in ChatView and in
 * CanvasDecisionPanel — mutually exclusive (canvasMode toggle), one live instance.
 *
 * Chat may omit ApprovalPrompt here and remount it flush above MessageInput
 * (composer 一体态); canvas keeps the default stack in CommandRegion.
 */
import { ApprovalPrompt } from "./ApprovalPrompt";
import { DelegationAuthorizationPrompt } from "./DelegationAuthorizationCard";
import { ResumePrompt } from "./ResumePrompt";
import { RunConfirmPrompt } from "./RunConfirmPrompt";
import { SettledElsewhereNotices } from "./SettledElsewhereNotices";

export function ConversationDecisionPrompts({
  omitApproval = false,
}: {
  /**
   * When true, skip {@link ApprovalPrompt} here — ChatView mounts it flush above
   * MessageInput for composer-一体态 (仍同一组件 / 同一 interactions 热路).
   */
  omitApproval?: boolean;
}) {
  return (
    <>
      {/* 卡被另一端拍板后留在原位的只读收口——不随 omitApproval 走，它交代的是
          决策区里刚消失的**任意**一张卡（含 ChatView 另挂的审批卡）。 */}
      <SettledElsewhereNotices />
      <ResumePrompt />
      <DelegationAuthorizationPrompt />
      {!omitApproval && <ApprovalPrompt />}
      <RunConfirmPrompt />
    </>
  );
}
