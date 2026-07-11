/**
 * 「在项目中继续」— open a new draft under a target project, carrying a
 * transcript summary from the source conversation (MVP: text only, no file copy).
 */

import { formatMessageExport } from "@/lib/messageExport";
import { startNewConversation } from "@/lib/newConversation";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { useComposerDraftStore } from "@/stores/composer";
import type { NavigateFunction } from "react-router-dom";

const SUMMARY_CAP = 6_000;

/** Build a short context brief from the source conversation's recent messages. */
export function buildContinueInProjectBrief(conversationId: string): string {
  const messages = getRuntime(conversationId).messages;
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const body =
      m.role === "assistant"
        ? formatMessageExport(m.content, m.process, "deliverable")
        : m.content.trim();
    if (!body) continue;
    const label = m.role === "user" ? "用户" : "助手";
    parts.push(`【${label}】\n${body}`);
  }
  const joined = parts.join("\n\n").trim();
  if (!joined) {
    return "（承接上一对话继续；原文无可用摘要。）";
  }
  const clipped =
    joined.length > SUMMARY_CAP
      ? `${joined.slice(0, SUMMARY_CAP)}\n\n…（摘要已截断）`
      : joined;
  return `【承接自上一对话的上下文摘要】\n\n${clipped}`;
}

/**
 * Switch to a new draft in `folderId`, prefill composer with source summary.
 */
export function continueInProject(
  navigate: NavigateFunction,
  sourceConversationId: string,
  folderId: string,
): void {
  const brief = buildContinueInProjectBrief(sourceConversationId);
  startNewConversation(navigate, folderId);
  // After startNewConversation clears the active conversation, seed the draft.
  useComposerDraftStore.getState().fill(brief, "replace");
  // Ensure we're on the draft composer (fill may target current draft key).
  useConversationStore.getState().switchConversation(null);
}
