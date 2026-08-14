/**
 * 全量重放段落地前的本地重置（clear-then-fold · 流式回复持久化 §3.6）。
 *
 * 只在服务端明令「本段是全量重放」（段首 ``message_start.full_replay``）时执行——那是段首
 * 指令，不是客户端按屏幕上的气泡去猜。两条 attach 路（回合级 ``attachConversation``、对话级
 * ``conversationFollow``）共用这一份重置。
 *
 * 原位清空正文 / 思考 / process / 执行槽，**保留匹配的气泡 id**——换泡会把已画上的 Markdown
 * 整棵卸掉再挂，打开/刷新时正文看起来像又加载了一次。不清空则 ``content_delta`` 会叠在消息窗
 * 已有正文上。多余的幽灵助手行仍删掉。执行槽仍清，供协作图一次重折（禁止 running→completed 闪）。
 */
import { discardAllPendingChunks } from "@/services/sse/contentBuffer";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { lastUserMessageOf } from "./helpers";

/**
 * Empty the assistant lane after ``userMessageId`` without minting a new bubble.
 * When ``keepMessageId`` is set, keep the matching assistant and drop the rest
 * (ghost streaming placeholders). Otherwise keep the last assistant.
 */
export function resetAssistantsAfterUserInPlace(
  conversationId: string,
  userMessageId: string,
  keepMessageId?: string,
): boolean {
  const rt = getRuntime(conversationId);
  const idx = rt.messages.findIndex((m) => m.id === userMessageId);
  if (idx === -1) return false;
  const assistants = rt.messages
    .slice(idx + 1)
    .filter((m) => m.role === "assistant");
  if (assistants.length === 0) return false;

  const keep =
    (keepMessageId
      ? assistants.find(
          (m) => m.id === keepMessageId || m.serverMessageId === keepMessageId,
        )
      : undefined) ?? assistants[assistants.length - 1];

  const exec = useExecutionStore.getState();
  const store = useConversationStore.getState();
  for (const m of assistants) {
    exec.clearExecution(m.id);
    if (m.serverMessageId && m.serverMessageId !== m.id) {
      exec.clearExecution(m.serverMessageId);
    }
    if (m.id !== keep.id) {
      store.removeMessage(m.id, conversationId);
    }
  }
  store.updateMessage(
    keep.id,
    {
      content: "",
      reasoning: "",
      process: [],
      composingTool: null,
      finishReason: undefined,
      error: undefined,
    },
    conversationId,
  );
  discardAllPendingChunks(conversationId);
  return true;
}

/**
 * Reset whatever this turn already painted so a full-turn replay rebuilds it cleanly
 * (rejoin / 对话级订阅让位后重连). Without emptying the lane the replay appends its
 * transcript onto the partial and the reply reads twice.
 *
 * @returns whether a partial was actually reset (false = nothing to anchor on).
 */
export function resetPartialTurnForReplay(
  conversationId: string,
  replayMessageId?: string,
): boolean {
  const lastUser = lastUserMessageOf(conversationId);
  if (!lastUser) return false;
  return resetAssistantsAfterUserInPlace(
    conversationId,
    lastUser.id,
    replayMessageId,
  );
}
