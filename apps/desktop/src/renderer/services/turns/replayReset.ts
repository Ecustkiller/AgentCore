/**
 * 全量重放段落地前的本地重置（clear-then-fold · 流式回复持久化 §3.6）。
 *
 * 只在服务端明令「本段是全量重放」（段首 ``message_start.full_replay``）时执行——那是段首
 * 指令，不是客户端按屏幕上的气泡去猜。两条 attach 路（回合级 ``attachConversation``、对话级
 * ``conversationFollow``）共用这一份重置；单独成模块是为了不与 ``streamConversation`` 互相
 * import（``turns/recovery`` 反过来依赖它开流）。
 */
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { lastUserMessageOf } from "./helpers";

/**
 * Drop every assistant after ``userMessageId`` from the conversation slice **and**
 * wipe their process/execution slots, then open a fresh placeholder for the segment
 * to fold into — a full journal replay must not double-fold tools / team graph.
 */
function clearAfterUserForReplay(
  conversationId: string,
  userMessageId: string,
): void {
  const rt = getRuntime(conversationId);
  const idx = rt.messages.findIndex((m) => m.id === userMessageId);
  if (idx === -1) return;
  const exec = useExecutionStore.getState();
  for (const m of rt.messages.slice(idx + 1)) {
    if (m.role !== "assistant") continue;
    exec.clearExecution(m.id);
    if (m.serverMessageId && m.serverMessageId !== m.id) {
      exec.clearExecution(m.serverMessageId);
    }
  }
  const store = useConversationStore.getState();
  store.truncateAfter(userMessageId, conversationId);
  store.createAssistantMessage(conversationId);
}

/**
 * Reset whatever this turn already painted so a full-turn replay rebuilds it cleanly
 * (rejoin / 对话级订阅让位后重连). Without it the replay appends its transcript onto
 * the partial and the reply reads twice.
 *
 * @returns whether a partial was actually reset (false = nothing to anchor on).
 */
export function resetPartialTurnForReplay(conversationId: string): boolean {
  const lastUser = lastUserMessageOf(conversationId);
  if (!lastUser) return false;
  clearAfterUserForReplay(conversationId, lastUser.id);
  return true;
}
