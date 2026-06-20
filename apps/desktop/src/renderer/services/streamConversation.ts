import { patchConversationCache } from "@/hooks/useConversations";
import { addFolderCache } from "@/hooks/useFolders";
import { addWorkspaceFromFolder } from "@/hooks/useWorkspaces";
import { StreamError } from "@/lib/errors";
import { notifyUnauthorized, tryRefresh } from "@/services/api";
import type { FolderMeta } from "@/services/folders";
import type { PlanReviewUserDecision } from "@/services/planReview";
import { performWorkspaceOp } from "@/services/workspaceOps";
import { useApprovalStore } from "@/stores/approvals";
import {
  getRuntime,
  lastAssistantMessageId,
  useConversationStore,
} from "@/stores/conversation";
import {
  execRuntime,
  frameFromEvent,
  planFromRunPlan,
  useExecutionStore,
} from "@/stores/execution";
import type {
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  CitationsPayload,
  ContentDeltaPayload,
  DebateResultPayload,
  DebateRoundPayload,
  DebateRoundStartedPayload,
  ErrorPayload,
  MessageEndPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  QuestionPostedPayload,
  ReasoningDeltaPayload,
  RunPlanPayload,
  SSEEvent,
  TitleGeneratedPayload,
  ToolProgressPayload,
  ToolUseEndPayload,
  ToolUseStartPayload,
  TurnSavedPayload,
  WorkspaceOpRequiredPayload,
  WorkspacePromotedPayload,
} from "@/types/events";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

interface DispatchContext {
  conversationId: string;
}

/** Build a {@link StreamError} from a non-OK response. A refused turn (e.g. 429
 * for quota / rate limit) arrives as a plain JSON `{error:{code,message}}` body
 * with a `Retry-After` header — not an SSE stream — so pull those out for precise
 * UI phrasing. Falls back to status-only when the body isn't the expected shape. */
async function streamErrorFromResponse(
  response: Response,
): Promise<StreamError> {
  let code: string | undefined;
  let serverMessage: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = body.error?.code;
    serverMessage = body.error?.message;
  } catch {
    /* non-JSON body — keep status-only phrasing */
  }
  const header = Number(response.headers.get("Retry-After"));
  return new StreamError("http", response.status, {
    code,
    serverMessage,
    retryAfter: Number.isFinite(header) && header > 0 ? header : undefined,
  });
}

/**
 * Ensure the streamed conversation's last message is a streaming assistant
 * message.
 *
 * Backend always emits `message_start` before content, but this stays
 * defensive so a stray `content_delta` never lands on the user bubble. Targets
 * the turn's conversation by id so a background turn opens its bubble on its own
 * slice, not whatever conversation is on screen.
 */
function ensureStreamingAssistant(conversationId: string): void {
  const messages = getRuntime(conversationId).messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !last.isStreaming) {
    useConversationStore.getState().createAssistantMessage(conversationId);
  }
}

/**
 * rAF 合批 content_delta（流式渲染性能）。
 *
 * 后端逐 token 推 content_delta，每个都直接写 store 会让 Markdown 每 token 全量重渲染
 * （叠加块级记忆化前尤甚）。这里把同一会话「一帧内」的 delta 攒成一批，在下一次
 * animation frame 一次性 append——把每秒上百次 store 写入降到 ≤60 次。按 conversationId
 * 分桶，故多个后台会话各自合批、互不串台。
 *
 * 必须在回合收尾前 flush：`appendToLastMessage` / `finalizeLastMessage` 都不校验
 * `isStreaming`，缓冲若漏到收尾之后，rAF 回调会把尾 token 追加到已结束（极端情况下是下一条）
 * 的消息上。故 `message_end` / `error` 分支会先 flush，传输层 finally 再兜底 flush。
 */
const pendingContent = new Map<string, string>();
const pendingFrame = new Map<string, number>();

/** 立即写出某会话已缓冲的 content，并取消其挂起的 frame。无缓冲时为 no-op。 */
export function flushPendingContent(conversationId: string): void {
  const frame = pendingFrame.get(conversationId);
  if (frame !== undefined) {
    cancelAnimationFrame(frame);
    pendingFrame.delete(conversationId);
  }
  const buffered = pendingContent.get(conversationId);
  if (buffered === undefined) return;
  pendingContent.delete(conversationId);
  useConversationStore.getState().appendToLastMessage(buffered, conversationId);
}

/** 丢弃某会话已缓冲但未写出的 content（取消挂起 frame，且不 append）。`content_reset` 用：
 * 那批 delta 属于被交付前核验否决的违规正文，无需落到气泡。无缓冲时仅取消挂起 frame。 */
export function discardPendingContent(conversationId: string): void {
  const frame = pendingFrame.get(conversationId);
  if (frame !== undefined) {
    cancelAnimationFrame(frame);
    pendingFrame.delete(conversationId);
  }
  pendingContent.delete(conversationId);
}

/** 把一段 content delta 入桶，并确保已排定一次 frame flush。 */
function queueContentDelta(conversationId: string, delta: string): void {
  pendingContent.set(
    conversationId,
    (pendingContent.get(conversationId) ?? "") + delta,
  );
  if (pendingFrame.has(conversationId)) return;
  const frame = requestAnimationFrame(() => {
    pendingFrame.delete(conversationId);
    flushPendingContent(conversationId);
  });
  pendingFrame.set(conversationId, frame);
}

/**
 * Single source of truth for SSE event handling.
 *
 * Conversation-level events feed the chat store (single-agent path).
 * `run_*` and tool events feed the execution store — they no-op while no
 * execution exists, so the multi-agent UI lights up automatically once the
 * backend starts emitting them, with zero further frontend wiring.
 */
export function dispatchSSEEvent(event: SSEEvent, ctx: DispatchContext): void {
  // The execution store keys each turn's graph by the assistant message it
  // produced (§9.3). Every run/tool fact of a turn belongs to the bubble opened
  // by `message_start`, so resolve that id from the conversation's live slice
  // and route execution mutations to it (live + replay then share one slot).
  const execMessageId = (): string | null =>
    lastAssistantMessageId(getRuntime(ctx.conversationId).messages);

  switch (event.type) {
    // ---- single-agent conversation stream ----
    case "message_start": {
      ensureStreamingAssistant(ctx.conversationId);
      useConversationStore.getState().setGenerating(true, ctx.conversationId);
      break;
    }
    case "content_delta": {
      ensureStreamingAssistant(ctx.conversationId);
      // rAF-batched: coalesce a frame's worth of deltas into one store write
      // (and one Markdown re-render) instead of one per token.
      queueContentDelta(
        ctx.conversationId,
        (event.payload as ContentDeltaPayload).delta,
      );
      break;
    }
    case "content_reset": {
      // 交付前核验回炉：done 轮草稿未过轻层核验（如编造引用），引擎丢弃并重写。先丢掉 rAF
      // 缓冲里未写出的违规 delta，再清空气泡正文（含 process 尾部 content 步），使「违规版 →
      // 修正版」是一次干净替换而非追加。镜像后端 `_accumulate_process` 的 reset 分支。
      discardPendingContent(ctx.conversationId);
      useConversationStore.getState().resetStreamingContent(ctx.conversationId);
      break;
    }
    case "reasoning_delta": {
      ensureStreamingAssistant(ctx.conversationId);
      // Drain rAF-buffered content first so the process timeline folds steps in
      // true emission order: content is rAF-batched but reasoning is applied now,
      // so a queued「正文」must land before this「思考」step or the inline timeline
      // would mis-order them (前端UX设计.md §一B). No-op when nothing is buffered.
      flushPendingContent(ctx.conversationId);
      useConversationStore
        .getState()
        .appendReasoningToLastMessage(
          (event.payload as ReasoningDeltaPayload).delta,
          ctx.conversationId,
        );
      break;
    }
    case "tool_progress": {
      // Captain composing a tool call's args (e.g. the delegate 任务书) — drive the
      // bubble's「正在生成」line. Bubble-scoped twin of run_tool_progress (workers).
      ensureStreamingAssistant(ctx.conversationId);
      const p = event.payload as ToolProgressPayload;
      useConversationStore
        .getState()
        .setComposingTool(
          { toolName: p.tool_name, chars: p.chars },
          ctx.conversationId,
        );
      break;
    }
    case "message_end": {
      // Drain any rAF-buffered content BEFORE finalizing — finalize doesn't gate
      // on isStreaming, so a late flush would land on the wrong (finished) message.
      flushPendingContent(ctx.conversationId);
      const payload = event.payload as MessageEndPayload;
      const conv = useConversationStore.getState();
      // Stamp the turn total (回合总账) onto the assistant bubble before
      // finalizing, so the per-turn cost row (§7.3A) renders from state; null on
      // the error / not-found paths where no turn ran.
      if (payload.cost) {
        conv.attachCostToLastMessage(payload.cost, ctx.conversationId);
      }
      conv.finalizeLastMessage(ctx.conversationId);
      // The turn is over — any approval still on screen is moot (all were
      // resolved to get here; this just guards a degraded/edge end).
      useApprovalStore.getState().clear(ctx.conversationId);
      // Settle this turn's graph (keyed by its assistant message) to its final
      // state; resolve the id before releasing the slice below.
      const mid = execMessageId();
      if (mid) {
        const rt = execRuntime(useExecutionStore.getState(), mid);
        if (rt.plan && rt.status !== "failed") {
          useExecutionStore.getState().setStatus("completed", mid);
        }
      }
      // A turn that finished while the user is on another conversation leaves an
      // idle background slice that no switch will reclaim; release it now so the
      // memory bound holds (no-op for the active conversation — it reloads from
      // the server on return).
      conv.releaseBackgroundSlice(ctx.conversationId);
      break;
    }
    case "error": {
      // Same as message_end: flush buffered content before the bubble finalizes.
      flushPendingContent(ctx.conversationId);
      ensureStreamingAssistant(ctx.conversationId);
      const store = useConversationStore.getState();
      const payload = event.payload as ErrorPayload;
      // Attach a structured error to the bubble (rendered as a friendly inline
      // card) rather than splicing a raw `**Error**:` line into the answer text.
      store.attachErrorToLastMessage(
        { code: payload.code, message: payload.message },
        ctx.conversationId,
      );
      store.finalizeLastMessage(ctx.conversationId);
      useApprovalStore.getState().clear(ctx.conversationId);
      const mid = execMessageId();
      if (mid && execRuntime(useExecutionStore.getState(), mid).plan) {
        useExecutionStore.getState().setStatus("failed", mid);
      }
      // Failed turn in the background → same idle-slice reclaim as message_end
      // (a transport failure instead routes through turns.ts, which keeps the
      // slice so its retry banner survives).
      store.releaseBackgroundSlice(ctx.conversationId);
      break;
    }

    // ---- tool approval gate (CEO chat path) ----
    // A GRANTABLE tool call is paused awaiting the user's decision; the inline
    // prompt (rendered above the composer) settles it via the resolve endpoint.
    case "approval_required": {
      useApprovalStore.getState().add(event.payload as ApprovalRequiredPayload);
      break;
    }
    case "approval_resolved": {
      useApprovalStore
        .getState()
        .remove((event.payload as ApprovalResolvedPayload).approval_id);
      break;
    }
    case "checkpoint_required": {
      // Unlike approvals (a transient store), a checkpoint lives on its assistant
      // message so it replays inline; attach a pending card to the live bubble.
      useConversationStore
        .getState()
        .addCheckpoint(
          event.payload as CheckpointRequiredPayload,
          ctx.conversationId,
        );
      break;
    }
    case "checkpoint_resolved": {
      const p = event.payload as CheckpointResolvedPayload;
      useConversationStore
        .getState()
        .settleCheckpoint(
          p.checkpoint_id,
          p.decision,
          p.note ?? "",
          p.selected ?? [],
          ctx.conversationId,
        );
      break;
    }
    case "question_posted": {
      // Non-blocking ask (ask_user blocking=false): like a checkpoint it lives on its
      // assistant message so it replays inline, but it never gates — attach a
      // non-gating card to the live bubble (no resolve; chips 回填 the composer).
      useConversationStore
        .getState()
        .addNonBlockingAsk(
          event.payload as QuestionPostedPayload,
          ctx.conversationId,
        );
      break;
    }
    case "plan_review_required": {
      // Like an ask_user checkpoint (and unlike a transient approval), a
      // plan_review lives on its assistant message so it replays inline; attach a
      // pending card to the live bubble. Also fold it into the team graph as a
      // frame so the gated node shows a pause badge (结构化挂起 2a, 7.2A).
      useConversationStore
        .getState()
        .addPlanReview(
          event.payload as PlanReviewRequiredPayload,
          ctx.conversationId,
        );
      {
        const mid = execMessageId();
        const frame = frameFromEvent(event);
        if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      }
      break;
    }
    case "plan_review_resolved": {
      const p = event.payload as PlanReviewResolvedPayload;
      useConversationStore
        .getState()
        .settlePlanReview(
          p.checkpoint_id,
          p.decision,
          p.note ?? "",
          ctx.conversationId,
        );
      {
        const mid = execMessageId();
        const frame = frameFromEvent(event);
        if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      }
      break;
    }
    case "title_generated": {
      patchConversationCache(ctx.conversationId, {
        title: (event.payload as TitleGeneratedPayload).title,
      });
      break;
    }
    case "turn_saved": {
      const payload = event.payload as TurnSavedPayload;
      useConversationStore
        .getState()
        .reconcileLastTurn(payload.user_message_id, ctx.conversationId);
      break;
    }
    case "citations": {
      const payload = event.payload as CitationsPayload;
      useConversationStore
        .getState()
        .attachCitationsToLastMessage(payload.citations, ctx.conversationId);
      break;
    }

    // ---- local-workspace op channel (双模式工作区 P2) ----
    // In local mode the server-side LocalWorkspace asks us to run a file op
    // against the bound FS root; perform it and POST the result back (fire and
    // forget — it settles the paused op in this same SSE turn). No-op in cloud
    // mode, where this event never arrives.
    case "workspace_op_required": {
      void performWorkspaceOp(
        event.payload as WorkspaceOpRequiredPayload,
        ctx.conversationId,
      );
      break;
    }

    // ---- 裸聊懒升级（文件夹即工作区 §懒建 / 工作区对称化 D1a）----
    // The server minted a real folder for this 裸聊 on its first file write and filed
    // the conversation into it. Reflect that into the same caches a folder create
    // would touch, so the promotion is visible NOW instead of after a refetch/reload:
    // ① the grouped folder list (sidebar gains a folder filter row), ② the
    // conversation's folderId (it re-groups under that folder, leaving 未分组), ③ the
    // 文件 hub workspace rail (the new card — local promotions carry their subpath, so
    // the file the team just wrote is reachable). addWorkspaceFromFolder is a no-op if
    // the hub was never opened (it fetches fresh on first open).
    case "workspace_promoted": {
      const p = event.payload as WorkspacePromotedPayload;
      const folder: FolderMeta = {
        id: p.folder_id,
        name: p.name,
        localDir: null,
        localRootId: p.local_root_id,
        localSubpath: p.local_subpath,
      };
      addFolderCache(folder);
      patchConversationCache(p.conversation_id, { folderId: p.folder_id });
      addWorkspaceFromFolder(folder);
      break;
    }

    // ---- multi-agent execution stream ----
    // Each run/tool fact is appended to the journal; the graph is a projection
    // of that frame stream (see stores/execution.ts), so live + replay share
    // one fold and there is no per-event UI wiring beyond recording the fact.
    case "run_plan": {
      const payload = event.payload as RunPlanPayload;
      const mid = execMessageId();
      if (!mid) break;
      // ingestPlan (not startExecution): a second delegate batch in the same
      // turn shares the execution id and is merged into the live graph instead
      // of resetting it (see stores/execution.ts).
      useExecutionStore.getState().ingestPlan(planFromRunPlan(payload), mid);
      // Mark the assistant turn as team-driven: its bubble renders the inline
      // collaboration graph (统一团队展示草案) and defers the cost row to the
      // graph's status strip (§7.3A). Single-agent turns emit no run_plan, so
      // their bubble keeps `executionId === null` and shows its own ¥ caption.
      // The detail panel is no longer auto-opened — it is a passive drill-down
      // target, opened on demand by clicking a graph node.
      // multi_agent 与 debate 都让主气泡渲染 inline 团队图（辩论是 CEO→主持人→辩手的
      // 树）并把成本行让位给图的状态条。single_agent 不发 run_plan，气泡保留自己的 ¥。
      if (
        payload.plan_type === "multi_agent" ||
        payload.plan_type === "debate"
      ) {
        useConversationStore
          .getState()
          .setLastAssistantExecutionId(
            payload.execution_id,
            ctx.conversationId,
          );
      }
      break;
    }
    // All run facts fold the same way: map the event to a RunFrame and append it
    // to this turn's journal (a no-op slot has no plan, so stray single-agent
    // facts are ignored downstream). One path for every frame kind.
    case "run_started":
    case "run_context":
    case "run_output_delta":
    case "run_reasoning_delta":
    case "run_tool_progress":
    case "run_completed":
    case "run_failed":
    case "run_progress": {
      const mid = execMessageId();
      const frame = frameFromEvent(event);
      if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      break;
    }
    // Tool facts feed BOTH surfaces, so dispatch stays turn-type-agnostic: the
    // multi-agent team graph (recordFrame — a no-plan slot ignores them) AND the
    // single-agent 思考+工具 process timeline on the assistant bubble. A turn shows
    // exactly one (graph when it delegated, process panel otherwise).
    case "tool_use_start": {
      const mid = execMessageId();
      const frame = frameFromEvent(event);
      if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      // Drain rAF-buffered content first so a preceding「正文」step lands before this
      // tool step in the inline process timeline (ordering, see reasoning_delta).
      flushPendingContent(ctx.conversationId);
      useConversationStore
        .getState()
        .addProcessTool(
          event.payload as ToolUseStartPayload,
          ctx.conversationId,
        );
      break;
    }
    case "tool_use_end": {
      const mid = execMessageId();
      const frame = frameFromEvent(event);
      if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
      // Keep the timeline ordered: flush any buffered content before resolving the
      // tool step (a content delta can arrive between start and end).
      flushPendingContent(ctx.conversationId);
      useConversationStore
        .getState()
        .endProcessTool(event.payload as ToolUseEndPayload, ctx.conversationId);
      break;
    }

    // 辩论收场：把完整结构化产物（简报 + 叙事线）存入该回合 execution slot（直播与重连
    // 回放同一路径），辩论视图据此渲染；无 plan 的 slot 忽略（杂散事件）。
    case "debate_result": {
      const mid = execMessageId();
      if (mid)
        useExecutionStore
          .getState()
          .recordDebateResult(event.payload as DebateResultPayload, mid);
      break;
    }

    // 辩论逐轮增量（进行中实时叠加）：主持人每轮焦点（发言前）/ 小结 + 裁判（发言后）折入该
    // 回合 slot 的 debateRounds，让辩论视图进行中就逐轮叠出，不必干等 debate_result 收场。
    case "debate_round_started": {
      const mid = execMessageId();
      if (mid) {
        const p = event.payload as DebateRoundStartedPayload;
        useExecutionStore.getState().recordDebateRound(
          { round_no: p.round_no, focus: p.focus, summary: "", verdict: null, sides: [] },
          mid,
        );
      }
      break;
    }
    case "debate_round": {
      const mid = execMessageId();
      if (mid) {
        const p = event.payload as DebateRoundPayload;
        useExecutionStore.getState().recordDebateRound(
          {
            round_no: p.round_no,
            focus: p.focus,
            summary: p.summary,
            verdict: p.verdict,
            sides: p.sides,
          },
          mid,
        );
      }
      break;
    }

    default:
      break;
  }
}

/** 发送给后端的附件载荷（含提取出的正文）。 */
export interface OutgoingAttachment {
  name: string;
  path: string;
  /** 文件为正文；目录为「文件清单」文本。 */
  text: string;
  truncated: boolean;
  /** file=单文件；dir=目录文件清单；conversation=引用对话（正文为其最近若干条消息）。 */
  kind?: "file" | "dir" | "conversation";
  /** 仅 kind=conversation：被引用对话的 id（供气泡 chip 标注 / 后续跳转）。 */
  conversation_id?: string;
}

/**
 * Drain an SSE response body, routing every `data:` event through
 * `dispatchSSEEvent`. Shared by the POST turn channel (send / regenerate /
 * resume) and the GET re-attach channel (实时重连续看 C1 · slice 1b) — every SSE
 * consumer folds events through the one dispatch, so a live stream, a reload, and
 * a reconnect all rebuild identical state.
 *
 * Applies the idle stall watchdog: the backend heart-beats every ~15s while a
 * turn thinks, so a live connection always delivers bytes; total silence for the
 * timeout means the socket is dead (server / proxy dropped it), so we cancel and
 * raise a retriable network error rather than hang. This is an *idle* timeout,
 * never a total-duration cap — a long turn that keeps streaming (or just
 * heart-beating) is never cut off.
 */
async function pumpSSE(
  response: Response,
  conversationId: string,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  const IDLE_TIMEOUT_MS = 60_000;
  const readChunk = (): ReturnType<typeof reader.read> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Free the dead socket so the backend sees the disconnect (and, for an
        // attach, detaches again — the run keeps going regardless).
        void reader.cancel().catch(() => {});
        reject(new StreamError("network"));
      }, IDLE_TIMEOUT_MS);
      reader.read().then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

  while (true) {
    const { done, value } = await readChunk();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as SSEEvent;
        dispatchSSEEvent(event, { conversationId });
      } catch {
        /* malformed event — skip */
      }
    }
  }
}

/** Outcome of a re-attach attempt (执行与请求解耦 C1 · slice 1b). */
export type AttachOutcome =
  /** A live run was found; its transcript replayed and the stream was followed
   * (to `message_end`, or until the connection dropped — the caller distinguishes
   * via the thrown error). */
  | "attached"
  /** No run is live for the conversation (204) — already finished / never started
   * / suspended at a checkpoint. The caller falls back to the persisted transcript
   * (reload) or durable resume. */
  | "none";

/**
 * Re-attach to a conversation's in-flight turn and 续看 it live (C1 · slice 1b).
 *
 * Since a disconnect no longer cancels a turn (slice 1a — it runs detached +
 * persists), a client that dropped (network blip) or reopened the app can rejoin
 * the live run: the backend replays the transcript so far then tails new events,
 * all in the SAME shape as the original stream, so they fold through the one
 * `dispatchSSEEvent`. A pure observer — dropping it never cancels the run (an
 * explicit 停止 still goes through the stop endpoint).
 *
 * Returns `"none"` on a 204 (nothing live to rejoin). Throws a {@link StreamError}
 * on a transport drop while attached (retriable) or on auth — same contract as the
 * POST channel, so callers reuse the existing retry classification.
 */
export async function attachConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<AttachOutcome> {
  const doFetch = () =>
    fetch(`${BASE_URL}/v1/conversations/${conversationId}/stream`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/event-stream" },
      signal,
    });

  try {
    let response = await doFetch();
    if (response.status === 401) {
      if (await tryRefresh()) {
        response = await doFetch();
      }
      if (response.status === 401) {
        notifyUnauthorized();
        throw new StreamError("auth");
      }
    }
    // 204 = no live run to rejoin; let the caller reload the persisted transcript.
    if (response.status === 204) return "none";
    if (!response.ok) {
      throw await streamErrorFromResponse(response);
    }

    await pumpSSE(response, conversationId);

    // Stream ended without a terminal event while the turn still reads as
    // generating: the run finished + closed between our attach and replay, or the
    // connection dropped. Signal a retriable drop so the caller reloads / retries.
    if (getRuntime(conversationId).isGenerating) {
      throw new StreamError("network");
    }
    return "attached";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof StreamError) throw err;
    throw new StreamError("network");
  } finally {
    flushPendingContent(conversationId);
  }
}

/**
 * POST to an SSE endpoint and route every event through `dispatchSSEEvent`.
 *
 * Shared by send and regenerate: both are a POST returning `text/event-stream`.
 * Uses raw fetch (it must read the streaming body), so it can't ride the `api`
 * 401 interceptor — it mirrors that policy here: on an expired access token,
 * refresh once and replay, else drop to the login screen.
 */
async function runMessageStream(
  path: string,
  body: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  // Each turn streams into its own assistant message's execution slot (keyed by
  // message id, §9.3), so there is no prior graph to clear here — a fresh turn
  // gets a fresh slot on its first run_plan. Just drop any stale approval prompt
  // so the new turn starts from a clean gate.
  useApprovalStore.getState().clear(conversationId);

  const doFetch = () =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
      signal,
    });

  try {
    let response = await doFetch();
    if (response.status === 401) {
      if (await tryRefresh()) {
        response = await doFetch();
      }
      if (response.status === 401) {
        notifyUnauthorized();
        throw new StreamError("auth");
      }
    }

    if (!response.ok) {
      throw await streamErrorFromResponse(response);
    }

    await pumpSSE(response, conversationId);

    // Stream closed without a terminal event (message_end / inline error) while
    // the turn still reads as generating: the backend never signalled completion,
    // so the answer on screen may be truncated. Surface it as a retriable transport
    // failure — the caller keeps the partial text and raises the retry banner —
    // instead of silently finalizing, which would masquerade a half-streamed answer
    // as a finished reply (体验 bug). No-op on the normal paths, which already
    // finalized via message_end / error (so isGenerating is false here).
    if (getRuntime(conversationId).isGenerating) {
      throw new StreamError("network");
    }
  } catch (err) {
    // Re-raise user aborts (stop button) and already-typed failures as-is;
    // wrap anything else (fetch reject, reader break) as a network failure.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof StreamError) throw err;
    throw new StreamError("network");
  } finally {
    // Abort / network break skips message_end (and thus its flush); drain any
    // buffered tail so a partial answer keeps its last frame of tokens.
    flushPendingContent(conversationId);
  }
}

export interface StreamConversationOptions {
  conversationId: string;
  content: string;
  attachments?: OutgoingAttachment[];
  /** 「待定本地容器根」id（工作区对称化 D2）：桌面裸聊首发携带，让服务端首次产文件时把这条
   *  裸聊懒建为该容器下的 per 对话本地文件夹（D1a）。已归档 / 云端逃生口 / 非桌面 → 省略。 */
  localContainerRootId?: string | null;
  signal?: AbortSignal;
}

/**
 * Send a user message and consume the SSE response stream.
 *
 * This is the primary streaming channel for the app.
 */
export async function streamConversation({
  conversationId,
  content,
  attachments,
  localContainerRootId,
  signal,
}: StreamConversationOptions): Promise<void> {
  const payload: Record<string, unknown> = { content };
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  // 仅在有信号时携带——服务端 SendMessageRequest.local_container_root_id 缺省即走云端懒建。
  if (localContainerRootId)
    payload.local_container_root_id = localContainerRootId;
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages`,
    JSON.stringify(payload),
    conversationId,
    signal,
  );
}

export interface RegenerateConversationOptions {
  conversationId: string;
  /** The user message to re-run from (its later messages are dropped). */
  messageId: string;
  /** When set, edit the user message before re-running (edit & resend). */
  content?: string;
  signal?: AbortSignal;
}

/**
 * Re-run a turn from an existing user message and consume the SSE stream.
 *
 * Backend truncates everything after `messageId` and produces a fresh assistant
 * reply, so the persisted history stays consistent (no duplicate user turns).
 */
export async function regenerateConversation({
  conversationId,
  messageId,
  content,
  signal,
}: RegenerateConversationOptions): Promise<void> {
  const body = JSON.stringify(content !== undefined ? { content } : {});
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages/${messageId}/regenerate`,
    body,
    conversationId,
    signal,
  );
}

export interface ResumeConversationOptions {
  conversationId: string;
  /** The paused turn's assistant message_id (the durable resume key). */
  messageId: string;
  /** continue (proceed — run the gated downstream / accept the CEO direction) /
   * adjust (inject `note` as a steer, then continue) / stop (end the turn here). */
  decision: PlanReviewUserDecision;
  /** Steer for `adjust`, a closing remark for `stop`; ignored for `continue`. */
  note: string;
  /** ask_user option pick(s); ignored for plan_review (the server drops any pick
   * not actually offered). */
  selected?: string[];
  signal?: AbortSignal;
}

/**
 * Continue a durably-paused turn and consume its SSE stream (结构化挂起 2b resume).
 *
 * The turn paused at a plan_review / ask_user checkpoint and lost its live stream
 * (disconnect / restart). The backend claims the persisted frame (atomic
 * read-and-delete, so a turn never resumes twice — a stale / second call 404s) and
 * drives the rest of the turn on this fresh stream, same event shape as a send
 * (run/tool frames, the checkpoint resolution, content deltas, `message_end`).
 */
export async function resumeConversation({
  conversationId,
  messageId,
  decision,
  note,
  selected = [],
  signal,
}: ResumeConversationOptions): Promise<void> {
  const body = JSON.stringify({ decision, note, selected });
  await runMessageStream(
    `/v1/conversations/${conversationId}/messages/${messageId}/resume`,
    body,
    conversationId,
    signal,
  );
}
