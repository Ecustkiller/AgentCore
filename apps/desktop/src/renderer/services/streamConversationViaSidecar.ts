import { patchConversationCache } from "@/hooks/useConversations";
import { StreamError } from "@/lib/errors";
import { notifySuccess, notifyWarning } from "@/lib/toast";
import { resolveSidecarInference } from "@/services/inferenceToken";
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
  SidecarDebateSeed,
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
  /** 工作区子路径（工作区对称化 D1a）：非空时主进程把 sidecar 绑定到 `容器根/子路径`，
   *  使懒建的 per 对话本地工作区各跑在自己目录里。空 = 该根自身（现行为）。 */
  subpath?: string;
  content: string;
  /** 先前对话历史（sidecar 无库，需由调用方从本地会话切片喂入）。 */
  history?: SidecarHistoryEntry[];
  /** 本轮用户气泡的乐观 id：回写落库后据此把它换成云端权威 id（仅当它仍是末条 user
   *  消息时——防用户在回写返回前又发了一条而误改）。 */
  optimisticUserId: string;
  /** 续辩种子（结构化补轮·B）：非空 = 本回合 debate 续上一场（焦点正交、首轮辩手读到上一场
   *  摘要）。普通回合缺省，逐字回退全新辩论。 */
  debateSeed?: SidecarDebateSeed;
  signal?: AbortSignal;
}

export interface ResumeViaSidecarOptions {
  conversationId: string;
  rootId: string;
  /** 工作区子路径（同 {@link StreamViaSidecarOptions.subpath}）：寻址按 root+subpath 起的
   *  sidecar 进程，使子路径工作区的续跑也落在自己目录里。空 = 该根自身。 */
  subpath?: string;
  /** 挂起回合的 assistant message_id（续跑键；也是事件路由 / cancel 的寻址键）。 */
  messageId: string;
  decision: "continue" | "adjust" | "stop";
  note: string;
  selected?: string[];
  /** 挂起回合的原始用户消息（来自帧）——续跑完成后随回写落库。 */
  userMessage: string;
  /** 注入的用户气泡 id（续跑前补回，见 `turns.runResume`）——回写据此对账。 */
  userMessageId: string;
  signal?: AbortSignal;
}

/** 一个轻量 turnId（cancel 的寻址键）。crypto.randomUUID 在 Electron renderer 可用。 */
function newTurnId(): string {
  return `t_${crypto.randomUUID()}`;
}

/**
 * 本回合 trace_id：32-hex（去掉 UUID 连字符），与服务端 `core/log_context.new_trace_id`
 * （`uuid4().hex`）同形、契合 `Message.trace_id` 的 `String(32)` 列。随云代理 LLM 调用上报
 * 并随回写落库，使一次本地回合的推理日志↔气泡归并为同一条可 grep 的 trace（打通气泡↔日志）。
 */
function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * 从一次失败的回合 RPC（`startTurn` / `resume`）拒绝里提取本地引擎真因（onStatus 没记到时的兜底）。
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
  subpath,
  content,
  history,
  optimisticUserId,
  debateSeed,
  signal,
}: StreamViaSidecarOptions): Promise<SidecarTurnResult> {
  const turnId = newTurnId();
  // 本回合 trace_id：贯穿云代理推理调用 + 回写落库，使推理日志↔气泡同 trace（打通气泡↔日志）。
  const traceId = newTraceId();
  // 云推理凭据（平台 key 不下放本机，走云端代理鉴权——Slice 4a）。取不到则带 undefined：
  // dev 下 sidecar 回退其自身配置，生产则以可重试的引擎错误失败（胜过静默跑成无计费回合）。
  const inference = (await resolveSidecarInference()) ?? undefined;
  return runSidecarTurn({
    conversationId,
    rootId,
    subpath,
    turnId,
    signal,
    failMessage: "本地引擎未能完成回合，请重试",
    invoke: () =>
      window.sidecarApi.startTurn({
        conversationId,
        rootId,
        subpath,
        turnId,
        traceId,
        userMessage: content,
        history,
        inference,
        debateSeed,
      }),
    writeBack: (result) =>
      persistAndReconcile(
        conversationId,
        content,
        optimisticUserId,
        traceId,
        result,
      ),
  });
}

/**
 * 续跑一个持久挂起的本地回合（结构化挂起 2b resume）—— `streamConversationViaSidecar` 的对偶。
 *
 * sidecar 回合暂停后应用关闭、帧落本机文件；重开会话经 `listPaused` 重现续跑卡，用户的决定经
 * 此函数下发到 sidecar 的 `resume`（claim 帧并跑 `resume_chat_pipeline`），过程事件与最终结果
 * 形态与一次普通本地回合完全一致，故复用同一套事件分发与回写。事件路由 / cancel 键用
 * message_id（一回合至多一个持久挂起）。
 */
export async function resumeConversationViaSidecar({
  conversationId,
  rootId,
  subpath,
  messageId,
  decision,
  note,
  selected,
  userMessage,
  userMessageId,
  signal,
}: ResumeViaSidecarOptions): Promise<SidecarTurnResult> {
  // 续跑同样要跑 LLM（重启后会新拉起引擎），故随带当前云推理凭据（同 startTurn）。
  const inference = (await resolveSidecarInference()) ?? undefined;
  // 本次续跑的 trace_id（同 startTurn）：贯穿续跑的推理调用 + 回写落库。
  const traceId = newTraceId();
  return runSidecarTurn({
    conversationId,
    rootId,
    subpath,
    turnId: messageId,
    signal,
    failMessage: "本地引擎未能完成续跑，请重试",
    invoke: () =>
      window.sidecarApi.resume({
        rootId,
        subpath,
        conversationId,
        messageId,
        traceId,
        decision,
        note,
        selected,
        inference,
      }),
    writeBack: (result) =>
      persistAndReconcile(
        conversationId,
        userMessage,
        userMessageId,
        traceId,
        result,
      ),
  });
}

interface RunSidecarTurnOptions {
  conversationId: string;
  rootId: string;
  /** 工作区子路径（D1a）：cancel / respond 据 root+subpath 寻址到正确的 sidecar 进程。 */
  subpath?: string;
  /** 事件路由 + cancel 的寻址键：新回合用 turnId，续跑用 message_id。 */
  turnId: string;
  signal?: AbortSignal;
  /** 兜底错误文案（onStatus / RPC 真因都取不到时）。 */
  failMessage: string;
  /** 实际的 RPC 调用（startTurn / resume），Promise 在回合结束时携最终结果 resolve。 */
  invoke: () => Promise<SidecarTurnResult>;
  /** 回合结束后回写云端（落库 + 计费 + 对账），best-effort。 */
  writeBack: (result: SidecarTurnResult) => Promise<void>;
}

/**
 * 在 renderer 这端把一次 sidecar RPC（startTurn / resume）「伪装成」普通流式回合：订阅事件流
 * 并原样喂 `dispatchSSEEvent`、桥接停止按钮到 `cancel`、收尾后回写云端、把本地引擎失败统一
 * 包成带诊断的 `StreamError("sidecar")`。新回合与续跑共用这套脚手架，仅 `invoke` / `writeBack`
 * 不同（避免两条链路各写一份事件/中止/错误处理）。
 */
async function runSidecarTurn({
  conversationId,
  rootId,
  subpath,
  turnId,
  signal,
  failMessage,
  invoke,
  writeBack,
}: RunSidecarTurnOptions): Promise<SidecarTurnResult> {
  // 回合从干净的审批门开始（与云链路一致）。
  useApprovalStore.getState().clear(conversationId);

  // 登记「本会话此刻是 sidecar 回合」（连同 root+subpath），使本回合内挂起的审批 / 交互结算
  // （统一入口 `resolveInteraction`）改走 `window.sidecarApi.respond` 回这条 stdio 链路（寻址到
  // 按 root+subpath 起的同一进程），而非云端 HTTP。
  setActiveSidecarTurn(conversationId, rootId, subpath);

  // 只消费本会话的事件；主进程已按 turnId 路由到本窗口，这里再按 conversationId 过滤，
  // 防一个 sidecar 服务多个会话时串台。
  // 本回合是否派发过任何 sidecar 事件——一个都没有 = 引擎没跑起来（启动期失败，无输出 /
  // 副作用），失败时据此标 `recoverable` 让 turns.sendTurn 安全降级回云端（阶段二）。
  let sawAnyEvent = false;
  const unsubscribe = window.sidecarApi.onEvent((push) => {
    if (push.conversationId !== conversationId) return;
    sawAnyEvent = true;
    dispatchSSEEvent(push.event as SSEEvent, { conversationId });
  });

  const onAbort = (): void => {
    void window.sidecarApi.cancel({ rootId, subpath, turnId });
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const result = await invoke();
    // 回合已在本机跑完——回写云端落库 + 计费，再对账乐观气泡（best-effort）。
    await writeBack(result);
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
      failMessage;
    // 启动期失败（一个事件都没派发）= 无任何输出 / 副作用，可安全改道云端重跑（阶段二降级）；
    // 中途失败（已开始流式 / 已调工具）则否，照常走「本地引擎出错」横幅 + 重试。
    throw new StreamError("sidecar", undefined, {
      serverMessage: detail,
      recoverable: !sawAnyEvent,
    });
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
 * 回合已在本机跑完并展示，落库/计费是旁路；`recordLocalTurn` 自带有限退避重试（幂等安全，
 * 服务端按 `user_message_id` / `run_id` 去重）。全部重试仍失败则**可见降级**：弹非阻断 toast
 * 提示本回合未同步 + 提供手动「重试同步」，而非静默丢历史、也不复用会话错误横幅（那语义是
 * 回合失败→重跑整轮，但回合其实成功了）。
 */
async function persistAndReconcile(
  conversationId: string,
  userMessage: string,
  optimisticUserId: string,
  traceId: string,
  result: SidecarTurnResult,
): Promise<void> {
  try {
    const saved = await recordLocalTurn(
      conversationId,
      userMessage,
      optimisticUserId,
      traceId,
      result,
    );
    applyReconcile(conversationId, optimisticUserId, saved);
  } catch (err) {
    console.error("[sidecar] 本地回合回写云端失败（历史未同步）", err);
    warnWriteBackFailed(
      conversationId,
      userMessage,
      optimisticUserId,
      traceId,
      result,
    );
  }
}

/**
 * 对账乐观气泡（等价云链路 turn_saved + title_generated）。user id 现已是客户端权威，故换 id
 * 通常是 X→X 无害交换；仍按「末条 user 仍是本轮乐观气泡」守卫——防用户在回写返回前又发了
 * 一条而改错对象。本会话首次产出的标题刷进侧栏缓存。
 */
function applyReconcile(
  conversationId: string,
  optimisticUserId: string,
  saved: Awaited<ReturnType<typeof recordLocalTurn>>,
): void {
  const messages = getRuntime(conversationId).messages;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser?.id === optimisticUserId) {
    useConversationStore
      .getState()
      .reconcileLastTurn(saved.user_message_id, conversationId);
  }
  if (saved.title) {
    patchConversationCache(conversationId, { title: saved.title });
  }
}

/**
 * 回写彻底失败的可见降级：非阻断 toast + 手动「重试同步」。手动重试再 POST（幂等安全）：成功
 * 则对账 + 成功提示，再失败则重新挂回提示（由用户决定何时再试，不无限自动循环）。
 */
function warnWriteBackFailed(
  conversationId: string,
  userMessage: string,
  optimisticUserId: string,
  traceId: string,
  result: SidecarTurnResult,
): void {
  notifyWarning("本回合未同步到云端", {
    description: "重开会话可能看不到这条回复。",
    action: {
      label: "重试同步",
      onClick: () => {
        void retryWriteBack(
          conversationId,
          userMessage,
          optimisticUserId,
          traceId,
          result,
        );
      },
    },
  });
}

/** 手动重试一次回写（toast 按钮触发）；成功对账并提示，失败重新挂回降级提示。 */
async function retryWriteBack(
  conversationId: string,
  userMessage: string,
  optimisticUserId: string,
  traceId: string,
  result: SidecarTurnResult,
): Promise<void> {
  try {
    const saved = await recordLocalTurn(
      conversationId,
      userMessage,
      optimisticUserId,
      traceId,
      result,
    );
    applyReconcile(conversationId, optimisticUserId, saved);
    notifySuccess("已同步到云端");
  } catch (err) {
    console.error("[sidecar] 本地回合回写重试失败（历史仍未同步）", err);
    warnWriteBackFailed(
      conversationId,
      userMessage,
      optimisticUserId,
      traceId,
      result,
    );
  }
}
