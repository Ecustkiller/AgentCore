/**
 * Conversation-level decision prompts shared by chat and canvas 指挥台.
 * Single component path (方案 §3.2 ResumePrompt 单挂载): ChatView and
 * CanvasDecisionPanel both render this — they are mutually exclusive mounts
 * (canvasMode toggle), so only one instance is live at a time.
 */
import { ApprovalPrompt } from "./ApprovalPrompt";
import { DelegationAuthorizationPrompt } from "./DelegationAuthorizationCard";
import { ResumePrompt } from "./ResumePrompt";
import { RunConfirmPrompt } from "./RunConfirmPrompt";

export function ConversationDecisionPrompts() {
  return (
    <>
      <ResumePrompt />
      <DelegationAuthorizationPrompt />
      <ApprovalPrompt />
      <RunConfirmPrompt />
    </>
  );
}
