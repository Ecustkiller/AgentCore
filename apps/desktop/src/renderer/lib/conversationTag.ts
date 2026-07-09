/** Conversation auto-tag enum (mirrors backend `conversations.tag`). */

export type ConversationTag =
  | "code_review"
  | "research"
  | "writing"
  | "analysis";

export const CONVERSATION_TAG_LABELS: Record<ConversationTag, string> = {
  code_review: "代码审查",
  research: "研究",
  writing: "写作",
  analysis: "分析",
};

export function conversationTagLabel(
  tag: string | null | undefined,
): string | null {
  if (!tag) return null;
  return (CONVERSATION_TAG_LABELS as Record<string, string>)[tag] ?? null;
}
