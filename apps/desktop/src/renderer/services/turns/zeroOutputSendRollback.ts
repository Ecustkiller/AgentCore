import { type Message, getRuntime } from "@/stores/conversation";
/**
 * Class B 零产出回滚：本发已落库、助手空失败、能力/限流码 → 撤用户泡+空助手。
 * 与 Class A（`isUnstartedSendRefusal` · SSE 未开 / 用户句未落库）分立，禁止并进。
 *
 * 桌面在 store 上判定（SSE error 后 `streamConversation` 常 resolve），不扫 SSE 列表。
 */
import { isZeroOutputSendRefusalCode } from "@agentcore/contract-types";

export type ZeroOutputSendRollback = {
  userId: string;
  error: {
    code: string;
    message: string;
  };
};

function assistantHasBody(assistant: Message): boolean {
  return Boolean(assistant.content.trim());
}

function assistantHasTools(assistant: Message): boolean {
  if (assistant.composingTool) return true;
  if (assistant.process?.some((s) => s.kind === "tool")) return true;
  return Boolean(
    assistant.runs?.events?.some((e) => e.type === "tool_use_start"),
  );
}

function assistantHasTokens(assistant: Message): boolean {
  const usage = assistant.usage;
  if (!usage) return false;
  return (
    (usage.input ?? 0) > 0 ||
    (usage.output ?? 0) > 0 ||
    (usage.reasoning ?? 0) > 0
  );
}

/**
 * 只根据本发 store 态判定是否 Class B。`runRegenerate` 不得调用。
 * `thrownCode`：catch 路径上 SSE 可能还没把 error 贴到助手泡。
 */
export function inspectZeroOutputSendRollback(
  conversationId: string,
  optimisticUserId: string,
  thrownCode?: string,
): ZeroOutputSendRollback | null {
  const messages = getRuntime(conversationId).messages;
  if (messages.some((m) => m.id === optimisticUserId)) return null;

  let assistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx <= 0) return null;
  const assistant = messages[assistantIdx];
  const user = messages[assistantIdx - 1];
  if (!user || user.role !== "user") return null;

  if (assistantHasBody(assistant)) return null;
  if (assistantHasTools(assistant)) return null;
  if (assistantHasTokens(assistant)) return null;

  const attached = assistant.error ?? assistant.usage?.error ?? null;
  const code = attached?.code ?? thrownCode;
  if (!code || !isZeroOutputSendRefusalCode(code)) return null;

  return {
    userId: user.id,
    error: {
      code,
      message: attached?.message ?? "",
    },
  };
}
