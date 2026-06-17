import { patchConversationCache } from "@/hooks/useConversations";
import { StreamError } from "@/lib/errors";
import { recordLocalTurn } from "@/services/localTurns";
import {
  clearActiveSidecarTurn,
  setActiveSidecarTurn,
} from "@/services/sidecarRouting";
import { takeRecentSidecarFailure } from "@/services/sidecarStatus";
import {
  dispatchSSEEvent,
  flushPendingContent,
} from "@/services/streamConversation";
import { useApprovalStore } from "@/stores/approvals";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import type { SSEEvent } from "@/types/events";
import type {
  SidecarHistoryEntry,
  SidecarTurnResult,
} from "@shared/sidecar-contract";

/**
 * 本地引擎（sidecar）对话流 —— 与 `streamConversation`（云 SSE）对偶的另一条链路。
 *
 * 双模式工作区 / 远期规划 §一.1：当一个会话绑定了本地授权根、且走 sidecar 时，回合由
 * 用户机器上的 `python -m agentcore.sidecar` 跑。本函数把那条 stdio JSON-RPC 链路在
 * renderer 这端「伪装成」一次普通流式回合：
 *
 * - 过程事件经主进程 `sidecar:event` 推来，**与服务端 SSE 同形状**，故原样喂给同一个
 *   `dispatchSSEEvent`——会话切片 / 执行图 / 工具时间线全部复用，零额外分支。
 * - `window.sidecarApi.startTurn` 的 Promise 在回合结束时 resolve（携带最终结果；流式
 *   细节已由事件给过）。主进程按 FIFO 先推完事件再回响应，故 resolve 时 `message_end`
 *   已派发、气泡已收尾。
 *
 * 回合结束后回写云端落库 + 计费（双模式工作区 §一.1）：sidecar 本机无库，故携回合结果调
 * `POST .../local-turns` 让云端入库 user/assistant 消息并按 run_id 幂等落 `cost_events`，
 * 再用返回的权威 id 对账乐观气泡——等价云链路的 `turn_saved`（换 user 消息 id）+
 * `title_generated`（更新侧栏标题）。回写是 best-effort 旁路：回合已在本机跑完并展示，
 * 落库失败只记录、不升级为回合失败（否则会把一个成功的回合误报为出错）。
 */

export interface StreamViaSidecarOptions {
  conversationId: string;
  /** 绑定的本地授权根 id（主进程据此解析绝对路径并复用 / 拉起该根的 sidecar）。 */
  rootId: string;
  content: string;
  /** 先前对话历史（sidecar 无库，需由调用方从本地会话切片喂入）。 */
  history?: SidecarHistoryEntry[];
  /** 本轮用户气泡的乐观 id：回写落库后据此把它换成云端权威 id（仅当它仍是末条 user
   *  消息时——防用户在回写返回前又发了一条而误改）。 */
  optimisticUserId: string;
  signal?: AbortSignal;
}

/** 一个轻量 turnId（cancel 的寻址键）。crypto.randomUUID 在 Electron renderer 可用。 */
function newTurnId(): string {
  return `t_${crypto.randomUUID()}`;
}

/**
 * 从一次失败的 `startTurn` 拒绝里提取本地引擎真因（onStatus 没记到时的兜底）。
 *
 * 回合中途引擎报错时进程仍健康（无 `error`/`exited` 推送），真因落在 RPC 错误的 message 里；
 * 而 Electron 会把主进程 handler 抛出的错误包成
 * `Error invoking remote method 'sidecar:startTurn': Error: <真因>`——剥掉这层包装与 `Error:`
 * 前缀，露出可读真因。提不出则返回 `null`，由调用方退到通用兜底文案。
 */
function describeSidecarTurnError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const unwrapped = err.message
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:Error|SidecarRpcError):\s*/, "")
    .trim();
  return unwrapped ? `本地引擎出错：${unwrapped}` : null;
}

/**
 * 发送一条用户消息，经本地 sidecar 跑完整回合并消费其事件流。
 *
 * 失败语义对齐云链路：用户停止（停止按钮）抛 `AbortError`；其余（拉不起 sidecar /
 * 引擎异常）包成带本地引擎诊断的 `StreamError("sidecar")`（优先 onStatus 记下的生命周期
 * 诊断，见下），由 `services/turns.ts` 统一出**针对性**横幅 + 重试。
 */
export async function streamConversationViaSidecar({
  conversationId,
  rootId,
  content,
  history,
  optimisticUserId,
  signal,
}: StreamViaSidecarOptions): Promise<SidecarTurnResult> {
  // 新回合从干净的审批门开始（与云链路一致）。
  useApprovalStore.getState().clear(conversationId);

  // 登记「本会话此刻是 sidecar 回合」，使本回合内挂起的审批 / 交互结算（统一入口
  // `resolveInteraction`）改走 `window.sidecarApi.respond` 回这条 stdio 链路，而非云端 HTTP。
  setActiveSidecarTurn(conversationId, rootId);

  const turnId = newTurnId();

  // 只消费本会话的事件；主进程已按 turnId 路由到本窗口，这里再按 conversationId 过滤，
  // 防一个 sidecar 服务多个会话时串台。
  const unsubscribe = window.sidecarApi.onEvent((push) => {
    if (push.conversationId !== conversationId) return;
    dispatchSSEEvent(push.event as SSEEvent, { conversationId });
  });

  const onAbort = (): void => {
    void window.sidecarApi.cancel({ rootId, turnId });
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const result = await window.sidecarApi.startTurn({
      conversationId,
      rootId,
      turnId,
      userMessage: content,
      history,
    });
    // 回合已在本机跑完——回写云端落库 + 计费，再对账乐观气泡（best-effort，见上）。
    await persistAndReconcile(
      conversationId,
      content,
      optimisticUserId,
      result,
    );
    return result;
  } catch (err) {
    // 用户停止：与云链路一致地抛 AbortError（调用方据此不出错误横幅）。
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    // 这条链路的失败**全部来自本地引擎**（拉不起 / 初始化失败 / 引擎异常 / 进程退出），从不是
    // 真正的「网络」。优先用 onStatus 记下的生命周期诊断（uv/venv 找不到、退出码…）换出针对性
    // 横幅；没有（如回合中途引擎报错，进程仍健康）则退回从该次拒绝里提取真因，最后兜底。
    const detail =
      takeRecentSidecarFailure(rootId) ??
      describeSidecarTurnError(err) ??
      "本地引擎未能完成回合，请重试";
    throw new StreamError("sidecar", undefined, { serverMessage: detail });
  } finally {
    // Abort / engine failure skips message_end (and thus its flush); drain any
    // rAF-buffered content so a partial answer keeps its last frame of tokens.
    flushPendingContent(conversationId);
    clearActiveSidecarTurn(conversationId);
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 回写云端落库 + 计费，并对账乐观气泡（双模式工作区 §一.1）。
 *
 * best-effort：回合已在本机跑完并展示，落库/计费是旁路——失败只记录、绝不抛错（否则会
 * 把一个成功的回合误报为出错并触发重试横幅）。代价是失败时本会话历史「未同步」，下次重开
 * 会话从云端拉取时该回合不在；这条通路 dev 开关下使用，可接受。
 */
async function persistAndReconcile(
  conversationId: string,
  userMessage: string,
  optimisticUserId: string,
  result: SidecarTurnResult,
): Promise<void> {
  try {
    const saved = await recordLocalTurn(conversationId, userMessage, result);
    // 仅当末条 user 消息仍是本轮乐观气泡时才换 id（等价云链路 turn_saved）——防用户在回写
    // 返回前又发了一条而改错对象。换 id 后失败重试走 regenerate 而非重发（不重复 user 轮）。
    const messages = getRuntime(conversationId).messages;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser?.id === optimisticUserId) {
      useConversationStore
        .getState()
        .reconcileLastTurn(saved.user_message_id, conversationId);
    }
    // 本会话首次产出标题：更新侧栏缓存（等价云链路 title_generated）。
    if (saved.title) {
      patchConversationCache(conversationId, { title: saved.title });
    }
  } catch (err) {
    console.error("[sidecar] 本地回合回写云端失败（历史未同步）", err);
  }
}
