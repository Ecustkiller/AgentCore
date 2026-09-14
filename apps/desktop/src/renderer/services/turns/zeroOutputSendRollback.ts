/**
 * 本发未开始回复 → 撤用户泡+空助手。思考正文 / 回答 / 工具 / 派工 算已开始。
 * 开跑前拒绝与已提交空失败同一条判定；错误码名单不是闸。
 *
 * 「本发是否已提交」由传输显式报告（云端 = 见过 `turn_saved`；sidecar = outbox
 * flush 成功）。未提交时仅当乐观用户 id 仍在（服务器尚未换 id）才滚，避免
 * 半落库状态误删。`runRegenerate` 不得调用。
 */
import {
  type SupportDiagnosticIds,
  supportDiagnosticExtrasFromError,
} from "@/lib/supportDiagnostics";
import {
  type Message,
  assistantProjectionId,
  getRuntime,
} from "@/stores/conversation";

export type ZeroOutputSendRollback = {
  userId: string;
  error: {
    code: string;
    message: string;
  };
  /** Collected before bubbles are removed — composer notice 复制排查包. */
  supportPack: SupportDiagnosticIds;
};

function assistantHasBody(assistant: Message): boolean {
  return Boolean(assistant.content.trim());
}

function assistantHasReasoning(assistant: Message): boolean {
  if (assistant.reasoning?.trim()) return true;
  return Boolean(
    assistant.process?.some(
      (s) => s.kind === "reasoning" && Boolean(s.text?.trim()),
    ),
  );
}

function assistantHasTools(assistant: Message): boolean {
  if (assistant.composingTool) return true;
  if (assistant.process?.some((s) => s.kind === "tool")) return true;
  return Boolean(
    assistant.runs?.events?.some((e) => e.type === "tool_use_start"),
  );
}

function assistantHasTeamWork(assistant: Message): boolean {
  if (assistant.process?.some((s) => s.kind === "team")) return true;
  return Boolean(
    assistant.runs?.events?.some((e) => {
      if (e.type !== "run_started") return false;
      const kind = (e.payload as { kind?: string } | undefined)?.kind;
      return Boolean(kind && kind !== "captain");
    }),
  );
}

function isKeepAlivePause(assistant: Message): boolean {
  if (assistant.outcome === "paused") return true;
  if (assistant.finishReason === "paused") return true;
  if (assistant.runs?.finishReason === "paused") return true;
  return false;
}

function collectSupportPack(
  conversationId: string,
  user: Message,
  assistant: Message,
  code: string,
): SupportDiagnosticIds {
  const attached = assistant.error ?? assistant.usage?.error ?? null;
  return {
    conversationId,
    messageId: assistantProjectionId(assistant),
    userMessageId: user.id,
    traceId: assistant.traceId ?? null,
    executionId: assistant.executionId,
    ...supportDiagnosticExtrasFromError(attached ?? { code, message: "" }),
  };
}

export type InspectUnstartedSendRollbackOpts = {
  /** When the transport never reported this send committed, only roll back
   * while the optimistic user id is still the last user (not swapped). */
  optimisticUserId?: string;
  /** catch 路径上 SSE 可能还没把 error 贴到助手泡。 */
  thrownCode?: string;
};

/**
 * 只根据本发 store 态 + 传输提交报告判定。`runRegenerate` 不得调用。
 */
export function inspectZeroOutputSendRollback(
  conversationId: string,
  turnCommitted: boolean,
  opts?: InspectUnstartedSendRollbackOpts,
): ZeroOutputSendRollback | null {
  const messages = getRuntime(conversationId).messages;

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

  if (!turnCommitted) {
    if (!opts?.optimisticUserId || user.id !== opts.optimisticUserId) {
      return null;
    }
  }

  if (isKeepAlivePause(assistant)) return null;
  if (assistantHasBody(assistant)) return null;
  if (assistantHasReasoning(assistant)) return null;
  if (assistantHasTools(assistant)) return null;
  if (assistantHasTeamWork(assistant)) return null;

  const attached = assistant.error ?? assistant.usage?.error ?? null;
  const code = attached?.code ?? opts?.thrownCode ?? "";

  return {
    userId: user.id,
    error: {
      code,
      message: attached?.message ?? "",
    },
    supportPack: collectSupportPack(conversationId, user, assistant, code),
  };
}
