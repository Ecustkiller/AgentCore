import type { ErrorAction } from "@/lib/errors";
import { useApprovalStore } from "@/stores/approvals";
import {
  type ExecutionJournal,
  execRuntime,
  useExecutionStore,
} from "@/stores/execution";
import type {
  AskAssumption,
  AskQuestion,
  AskStyleOption,
  CheckpointDecision,
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  Citation,
  CostBreakdown,
  PlanReviewPending,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  PlanReviewStep,
  ProcessStep,
  QuestionPostedPayload,
  SSEEvent,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@/types/events";
import { create } from "zustand";

/**
 * An ask_user prompt the CEO raised (the one asking surface — an opening 引导 or a
 * mid-task fork) projected for display. Lives on the assistant message it belongs
 * to (not a separate store like approvals) so it replays inline from the journal —
 * the question + answer are part of the conversation, not transient gating.
 * `status` flips `pending → resolved` on the `checkpoint_resolved` event (live) or
 * on the journal's resolved frame (replay). The rich opening content
 * (`assumptions` / `questions` / `styleOptions`) is empty for a compact mid-task
 * fork; `question` (the framing / opening line) is always present.
 */
export interface CheckpointDisplay {
  id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  styleOptions: AskStyleOption[];
  status: "pending" | "resolved";
  /** The settled decision; null while pending. */
  decision: CheckpointDecision | null;
  /** The user's composed answer / steer (continue) or closing remark (stop). */
  note: string;
  /** The option(s) the user picked (legacy/non-desktop clients); the desktop folds
   * its picks into `note`, so this is usually empty. */
  selected: string[];
}

/**
 * Fold a persisted turn journal's checkpoint events into display items, in the
 * order they were raised. Shared by live dispatch (none — live builds from the
 * SSE payloads directly) and history replay (ConversationPage.toMessage), so a
 * reloaded turn shows the same cards the live turn did.
 */
export function checkpointsFromEvents(events: SSEEvent[]): CheckpointDisplay[] {
  const byId = new Map<string, CheckpointDisplay>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type === "checkpoint_required") {
      const p = e.payload as CheckpointRequiredPayload;
      if (!byId.has(p.checkpoint_id)) order.push(p.checkpoint_id);
      byId.set(p.checkpoint_id, {
        id: p.checkpoint_id,
        question: p.question,
        context: p.context ?? "",
        assumptions: p.assumptions ?? [],
        questions: p.questions ?? [],
        styleOptions: p.style_options ?? [],
        status: "pending",
        decision: null,
        note: "",
        selected: [],
      });
    } else if (e.type === "checkpoint_resolved") {
      const p = e.payload as CheckpointResolvedPayload;
      const cur = byId.get(p.checkpoint_id);
      if (cur) {
        cur.status = "resolved";
        cur.decision = p.decision;
        cur.note = p.note ?? "";
        cur.selected = p.selected ?? [];
      }
    }
  }
  return order.map((id) => byId.get(id) as CheckpointDisplay);
}

/**
 * A non-blocking ask the CEO posted (ask_user blocking=false, Cursor 式) projected
 * for display. Like {@link CheckpointDisplay} it lives on the assistant message it
 * belongs to (so it replays from the journal), but it is NOT a gating checkpoint:
 * there is no `status` / `decision` — it was never pending. The card renders the
 * question + read-only 起步计划 + option chips that 回填 the composer; the user's
 * answer rides an ordinary next-turn message.
 */
export interface NonBlockingAskDisplay {
  id: string;
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  styleOptions: AskStyleOption[];
}

/**
 * Fold a persisted turn journal's `question_posted` events into display items, in the
 * order they were posted. Mirrors {@link checkpointsFromEvents} for the non-gating
 * ask, so a reloaded turn replays the same cards the live turn showed.
 */
export function nonBlockingAsksFromEvents(
  events: SSEEvent[],
): NonBlockingAskDisplay[] {
  const byId = new Map<string, NonBlockingAskDisplay>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type !== "question_posted") continue;
    const p = e.payload as QuestionPostedPayload;
    if (byId.has(p.ask_id)) continue;
    order.push(p.ask_id);
    byId.set(p.ask_id, {
      id: p.ask_id,
      question: p.question,
      context: p.context ?? "",
      assumptions: p.assumptions ?? [],
      questions: p.questions ?? [],
      styleOptions: p.style_options ?? [],
    });
  }
  return order.map((id) => byId.get(id) as NonBlockingAskDisplay);
}

/**
 * A structured DAG checkpoint the WaveScheduler paused on (plan_review, 结构化挂起
 * 2a) projected for display. Like {@link CheckpointDisplay} it lives on the
 * assistant message it belongs to (not a separate store) so it replays inline from
 * the journal. `steps` are the just-completed nodes under review, `pending` peeks
 * at the gated downstream; `status` flips `pending → resolved` on the
 * `plan_review_resolved` event (live) or the journal's resolved frame (replay).
 */
export interface PlanReviewDisplay {
  id: string;
  steps: PlanReviewStep[];
  pending: PlanReviewPending[];
  status: "pending" | "resolved";
  /** The settled decision; null while pending. */
  decision: CheckpointDecision | null;
  /** An optional closing remark; empty otherwise. */
  note: string;
}

/**
 * Fold a persisted turn journal's plan_review events into display items, in the
 * order they were raised. Mirrors {@link checkpointsFromEvents}: history replay
 * (toMessage) rebuilds the same cards the live turn showed (live builds from the
 * SSE payloads directly).
 */
export function planReviewsFromEvents(events: SSEEvent[]): PlanReviewDisplay[] {
  const byId = new Map<string, PlanReviewDisplay>();
  const order: string[] = [];
  for (const e of events) {
    if (e.type === "plan_review_required") {
      const p = e.payload as PlanReviewRequiredPayload;
      if (!byId.has(p.checkpoint_id)) order.push(p.checkpoint_id);
      byId.set(p.checkpoint_id, {
        id: p.checkpoint_id,
        steps: p.steps ?? [],
        pending: p.pending ?? [],
        status: "pending",
        decision: null,
        note: "",
      });
    } else if (e.type === "plan_review_resolved") {
      const p = e.payload as PlanReviewResolvedPayload;
      const cur = byId.get(p.checkpoint_id);
      if (cur) {
        cur.status = "resolved";
        cur.decision = p.decision;
        cur.note = p.note ?? "";
      }
    }
  }
  return order.map((id) => byId.get(id) as PlanReviewDisplay);
}

/**
 * Fold one reasoning delta into a single-agent process timeline: extend the
 * trailing reasoning step when the last step is thinking, else open a new one.
 * Coalescing consecutive deltas keeps the timeline a few segments (one per
 * think→act boundary) rather than one node per token. Mirrors the backend sink's
 * `_accumulate_process`, so a live turn and its reloaded twin read the same shape.
 */
function appendReasoningStep(
  process: ProcessStep[] | undefined,
  delta: string,
): ProcessStep[] {
  const steps = process ? [...process] : [];
  const last = steps[steps.length - 1];
  if (last && last.kind === "reasoning") {
    steps[steps.length - 1] = { ...last, text: last.text + delta };
  } else {
    steps.push({ kind: "reasoning", text: delta });
  }
  return steps;
}

/**
 * Fold one content delta into the single-agent process timeline: extend the
 * trailing content step when the last step is reply text, else open a new one.
 * Mirrors {@link appendReasoningStep} (and the backend sink's `_accumulate_process`)
 * so the CEO's reply text interleaves with its thinking + tool steps in true order —
 * the trailing content step is the final answer (前端UX设计.md §一B). Content also
 * keeps accumulating on `message.content` (copy / citations / the canonical text);
 * this only adds the ordered render lane.
 */
function appendContentStep(
  process: ProcessStep[] | undefined,
  delta: string,
): ProcessStep[] {
  const steps = process ? [...process] : [];
  const last = steps[steps.length - 1];
  if (last && last.kind === "content") {
    steps[steps.length - 1] = { ...last, text: last.text + delta };
  } else {
    steps.push({ kind: "content", text: delta });
  }
  return steps;
}

/** Append a started tool call as a `running` step to the process timeline. */
function appendToolStep(
  process: ProcessStep[] | undefined,
  payload: ToolUseStartPayload,
): ProcessStep[] {
  const steps = process ? [...process] : [];
  steps.push({
    kind: "tool",
    id: payload.tool_call_id,
    tool_name: payload.tool_name,
    arguments: payload.arguments ?? {},
    result: null,
    status: "running",
  });
  return steps;
}

/** Resolve a tool step (result + status) on its matching `tool_use_end`; returns
 * the same array reference when no step matches (id absent), so callers can no-op. */
function resolveToolStep(
  process: ProcessStep[] | undefined,
  payload: ToolUseEndPayload,
): ProcessStep[] | undefined {
  if (!process) return process;
  let changed = false;
  const steps = process.map((s) => {
    if (!changed && s.kind === "tool" && s.id === payload.tool_call_id) {
      changed = true;
      return {
        ...s,
        result: payload.result,
        status: payload.status,
        display: payload.display ?? null,
      };
    }
    return s;
  });
  return changed ? steps : process;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  /** Folder membership for the sidebar grouping (§七). Absent/null = 裸聊 (no
   * workspace yet). 文件夹即工作区: a chat's workspace/mode derives from its folder;
   * a 裸聊 is always cloud and owns no binding of its own. */
  folderId?: string | null;
  /** Selected 质量档 (D2): a preset key or custom-mode id; null/absent = inherit
   * the user/operator default. The composer picker reads/writes this. */
  modelMode?: string | null;
  /** Pinned to the top of the sidebar / list (置顶对话); absent = not pinned.
   * Lists sort pinned-first, then by recency. */
  pinned?: boolean;
  /** Archived = hidden from the live sidebar / list, surfaced only in the
   * 「已归档」view (归档对话, reversible). The grouped/live cache holds only
   * non-archived rows, so this is true only on the「已归档」view's rows. */
  archived?: boolean;
}

/** 附件在消息气泡上的展示元信息（不含正文，正文仅发送时携带）。 */
export interface MessageAttachmentMeta {
  id: string;
  name: string;
  path: string;
  truncated: boolean;
  /** file=单文件；dir=目录（附带文件清单）。缺省视为 file（兼容旧数据）。 */
  kind?: "file" | "dir";
  /** 附件驻留后在工作区内的相对路径（如 `attachments/foo.py`）；可经文件下载 API
   * 取回。仅文件型且已驻留时存在；目录与旧数据为空。 */
  workspacePath?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 模型思考过程（思考强度档下的 reasoning_content）；流式与历史回放共用。 */
  reasoning?: string;
  /** 单 Agent 回合的「思考·正文·工具」内联过程时间线（前端UX设计.md §一B）：CEO 自身
   * 的思考、回复正文与工具调用按真实发生顺序交织成一条流——气泡不再把正文单独抽到
   * 底部，末尾的 content 步即最终答案。流式时由 SSE 增量构建（reasoning_delta 续写尾部
   * 思考段、content_delta 续写尾部正文段、tool_use_* 落工具步），历史回放时由
   * `runs.process` 还原（toMessage）。多 Agent 回合改由团队图呈现（不读此字段）；后端
   * `_has_tool` 门控持久化——用过工具的回合落完整 content 步，纯对话/纯思考回合不落
   * process，回放时由 reasoning_content 合成单条思考段、正文回落 message.content。 */
  process?: ProcessStep[];
  createdAt: string;
  executionId: string | null;
  isStreaming: boolean;
  /** The tool call the CEO captain is *currently composing* (tool_progress): name +
   * chars of arguments streamed so far. Live-only (never persisted): set while the
   * captain assembles a big call (e.g. the delegate 任务书) before any content/graph,
   * cleared once content streams, the tool executes, or the turn ends. Drives the
   * bubble's「正在生成 {tool}…」line so the pre-delegate gap isn't blank. */
  composingTool?: { toolName: string; chars: number } | null;
  attachments?: MessageAttachmentMeta[];
  /** Web sources backing an assistant reply; rendered as source cards. */
  citations?: Citation[];
  /** Turn-total cost (回合总账) from `message_end.cost`; drives the per-turn cost
   * row (§7.3A). Absent until the turn ends. Ledger nano-USD shape (no
   * `cny_total` — the client converts via the single FX rate). All-zero `total`
   * renders as「—」, not「¥0.00」(§7.5). */
  cost?: CostBreakdown;
  /** Persisted multi-agent execution journal (the turn's ordered run/tool
   * events), set only on a *reloaded* assistant message so its team graph
   * replays on demand (the inline graph hydrates the execution slot from this).
   * Absent for user / single-agent turns and for the live turn (which streams
   * straight into the execution store). */
  runs?: ExecutionJournal;
  /** Checkpoints the CEO raised this turn (ask_user). Set live as the SSE events
   * arrive and rebuilt from the journal on reload, so the cards render inline
   * under this assistant bubble (会话流内，不并入状态条). Absent for turns with no
   * checkpoint. */
  checkpoints?: CheckpointDisplay[];
  /** Non-blocking asks the CEO posted this turn (ask_user blocking=false). Set live
   * as the `question_posted` events arrive and rebuilt from the journal on reload, so
   * the non-gating cards render inline under this assistant bubble. Absent for turns
   * with no non-blocking ask. */
  nonBlockingAsks?: NonBlockingAskDisplay[];
  /** Structured DAG checkpoints the WaveScheduler paused on this turn (plan_review,
   * 结构化挂起 2a). Set live as the SSE events arrive and rebuilt from the journal on
   * reload, so the cards render inline under this assistant bubble alongside any
   * ask_user checkpoints. Absent for turns with no plan_review. */
  planReviews?: PlanReviewDisplay[];
  /** A turn that failed mid-stream (an `error` SSE event), rendered as a friendly
   * inline error card under the (possibly partial) answer instead of a raw
   * `**Error**:` line. Live-only — the backend never persisted a partial failure,
   * so it does not replay on reload (same as the previous text behavior). */
  error?: { code: string; message: string };
}

/**
 * The turn total (回合总账) on the last assistant message, or null when none has
 * a priced total yet (§7.3A). The inline team graph's status strip reads this;
 * keeping the backward scan in one place is the single home for the turn-cost
 * lookup the team surfaces share.
 */
export const selectLastAssistantCostTotal = (
  messages: Message[],
): number | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant")
      return messages[i].cost?.total ?? null;
  }
  return null;
};

/**
 * Id of the last assistant message in a list (the live turn's bubble), or null.
 * The execution store keys each turn's graph by its assistant message id, so the
 * SSE dispatch routes run/tool frames here and {@link stopGeneration} cancels
 * the right message's graph — a turn's events all belong to the message opened
 * just before they stream.
 */
export function lastAssistantMessageId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].id;
  }
  return null;
}

/**
 * Per-conversation turn runtime — the live state of one conversation's stream.
 *
 * Keyed by conversation id in {@link ConversationState.byId} so several
 * conversations can have an in-flight (or just-finished) turn at once; the view
 * reads whichever slice is active. A draft chat with no id yet lives under
 * {@link DRAFT_KEY}.
 */
export interface ConversationRuntime {
  messages: Message[];
  isGenerating: boolean;
  /** AbortController for the in-flight turn (send or regenerate), if any. */
  abort: AbortController | null;
  /** User-facing error for the last failed turn, with a one-click retry. */
  error: string | null;
  retry: (() => void) | null;
  /** Optional remedy that routes the user to fix the cause (e.g. "去配置" → the
   * model-config page for a missing BYOK key), distinct from re-running the turn. */
  errorAction: ErrorAction | null;
  /** Cross-component "scroll to + flash" target. Set by surfaces that need to
   * jump the conversation to one message — e.g. the collaboration graph's CEO
   * captain 汇聚点 node pointing at this turn's final answer. The nonce re-triggers
   * the scroll/flash when the same message is focused again. */
  messageFocus: { id: string; nonce: number } | null;
  // ---- Cursor-window state (载入模型: 最新窗口 + 上下无限滚动 + 命中定位) ----
  // `messages` is a contiguous window of the conversation, not the whole history.
  // These flags say whether more exist past each edge (drive infinite scroll) and
  // whether a page is mid-flight (collapse a burst of scroll events into one
  // fetch). The live head invariant: a turn may stream only when `hasMoreAfter`
  // is false (the window reaches the tail); a search-hit jump that leaves it true
  // snaps back to latest before sending (see services/messages.ts).
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
}

/** Runtime key for a draft chat that has no conversation id yet. */
const DRAFT_KEY = "";

const EMPTY_RUNTIME: ConversationRuntime = {
  messages: [],
  isGenerating: false,
  abort: null,
  error: null,
  retry: null,
  errorAction: null,
  messageFocus: null,
  hasMoreBefore: false,
  hasMoreAfter: false,
  loadingOlder: false,
  loadingNewer: false,
};

/** A conversation's runtime slice, never undefined (empty default). Pass an id
 * for a specific conversation — used to route a background turn's stream to its
 * own slice — or omit it for the active one. Single source for every slice
 * selector and imperative reader. */
export function runtimeOf(
  state: ConversationState,
  conversationId?: string | null,
): ConversationRuntime {
  const key = conversationId ?? state.currentConversationId ?? DRAFT_KEY;
  return state.byId[key] ?? EMPTY_RUNTIME;
}

/** The active conversation's runtime slice (or an empty one). */
export function activeRuntime(state: ConversationState): ConversationRuntime {
  return runtimeOf(state);
}

interface ConversationState {
  currentConversationId: string | null;
  /** Live turn state per conversation id (draft chat under {@link DRAFT_KEY}). */
  byId: Record<string, ConversationRuntime>;
  /** A search-hit jump waiting for its conversation to open + load (命中必达). The
   * palette sets this and navigates; {@link ConversationPage} consumes it once
   * that conversation's window is loaded, then runs the load-around jump — so a
   * cross-conversation hit lands precisely without racing the page's own fetch. */
  pendingFocus: { conversationId: string; messageId: string } | null;

  setCurrentConversation: (id: string | null) => void;
  /** Drop a deleted conversation's live runtime: forget its turn slice and, if
   * it was the open one, clear the current pointer. The list row itself lives in
   * the React Query cache now (see hooks/useConversations). */
  dropConversationRuntime: (id: string) => void;
  setMessages: (messages: Message[]) => void;
  /** Replace a conversation's whole window (initial load + load-around jump),
   * resetting both edge flags. */
  setMessageWindow: (
    messages: Message[],
    flags: { hasMoreBefore: boolean; hasMoreAfter: boolean },
    conversationId?: string | null,
  ) => void;
  /** Prepend an older page (scroll up), updating `hasMoreBefore`. Deduped by id
   * so an overlapping page can't double a message. */
  prependMessages: (
    older: Message[],
    hasMoreBefore: boolean,
    conversationId?: string | null,
  ) => void;
  /** Append a newer *history* page (scroll down after a load-around jump),
   * updating `hasMoreAfter`. Deduped by id. Distinct from {@link addMessage},
   * which appends a single live/optimistic message. */
  appendNewerMessages: (
    newer: Message[],
    hasMoreAfter: boolean,
    conversationId?: string | null,
  ) => void;
  setLoadingOlder: (v: boolean, conversationId?: string | null) => void;
  setLoadingNewer: (v: boolean, conversationId?: string | null) => void;
  // Turn-stream mutators take an optional `conversationId`: SSE dispatch passes
  // the turn's id so a background turn writes to its own slice even while the
  // user views another conversation; UI callers omit it to target the active one.
  addMessage: (message: Message, conversationId?: string | null) => void;
  appendToLastMessage: (chunk: string, conversationId?: string | null) => void;
  appendReasoningToLastMessage: (
    chunk: string,
    conversationId?: string | null,
  ) => void;
  /** Set (or clear) the CEO captain's currently-composing tool call on the live
   * assistant message (tool_progress) — drives the bubble's「正在生成 {tool}…」line
   * during the pre-graph delegate-assembly gap. Cleared automatically when content
   * streams / the tool executes / the turn ends. */
  setComposingTool: (
    tool: { toolName: string; chars: number } | null,
    conversationId?: string | null,
  ) => void;
  /** Append a started tool call as a `running` step on the live assistant
   * message's single-agent process timeline (前端UX设计.md §一). Runs alongside the
   * execution store's `recordFrame`: that drives the multi-agent team graph, this
   * the single-agent inline process panel — a turn renders one or the other. */
  addProcessTool: (
    payload: ToolUseStartPayload,
    conversationId?: string | null,
  ) => void;
  /** Resolve a process-timeline tool step (result + status) on its
   * `tool_use_end`; no-op if the id isn't on the last assistant message. */
  endProcessTool: (
    payload: ToolUseEndPayload,
    conversationId?: string | null,
  ) => void;
  /** Attach aggregated web sources to the last assistant message (live turn). */
  attachCitationsToLastMessage: (
    citations: Citation[],
    conversationId?: string | null,
  ) => void;
  /** Attach the turn-total cost to the last assistant message (回合总账, from
   * `message_end.cost`); no-op if there is no cost or no assistant to attach to. */
  attachCostToLastMessage: (
    cost: CostBreakdown,
    conversationId?: string | null,
  ) => void;
  /** Mark the last assistant message as failed mid-stream (from an `error` SSE
   * event) so its bubble renders the friendly inline error card; no-op if there is
   * no assistant message to attach to. */
  attachErrorToLastMessage: (
    error: { code: string; message: string },
    conversationId?: string | null,
  ) => void;
  /** Append a checkpoint the CEO just raised (`checkpoint_required`) to the live
   * assistant message, as a pending card. Deduped by id; no-op if there is no
   * assistant message yet. */
  addCheckpoint: (
    payload: CheckpointRequiredPayload,
    conversationId?: string | null,
  ) => void;
  /** Flip a checkpoint to resolved (`checkpoint_resolved`, or an optimistic
   * settle on a stale resolve). Scans the slice's messages for the id; no-op if
   * it isn't found. */
  settleCheckpoint: (
    checkpointId: string,
    decision: CheckpointDecision,
    note: string,
    selected: string[],
    conversationId?: string | null,
  ) => void;
  /** Append a non-blocking ask the CEO just posted (`question_posted`) to the live
   * assistant message, as a non-gating card. Deduped by id; no-op if there is no
   * assistant message yet. There is no settle — it was never pending. */
  addNonBlockingAsk: (
    payload: QuestionPostedPayload,
    conversationId?: string | null,
  ) => void;
  /** Append a structured DAG checkpoint the WaveScheduler just paused on
   * (`plan_review_required`) to the live assistant message, as a pending card.
   * Deduped by id; no-op if there is no assistant message yet. */
  addPlanReview: (
    payload: PlanReviewRequiredPayload,
    conversationId?: string | null,
  ) => void;
  /** Flip a plan_review to resolved (`plan_review_resolved`, or an optimistic
   * settle on a stale resolve). Scans the slice's messages for the id; no-op if
   * it isn't found. */
  settlePlanReview: (
    checkpointId: string,
    decision: CheckpointDecision,
    note: string,
    conversationId?: string | null,
  ) => void;
  createAssistantMessage: (conversationId?: string | null) => string;
  finalizeLastMessage: (conversationId?: string | null) => void;
  updateMessage: (id: string, update: Partial<Message>) => void;
  /** Remove a single message from a conversation's window (单条消息删除). No-op if
   * the id isn't in the slice. */
  removeMessage: (id: string, conversationId?: string | null) => void;
  /** Drop every message after `id` (exclusive). Used by regenerate / edit. */
  truncateAfter: (id: string, conversationId?: string | null) => void;
  /** Replace the optimistic id of the last user message with the backend's
   * authoritative id (from `turn_saved`), so regenerate / edit / retry target
   * the real row. */
  reconcileLastTurn: (
    userMessageId: string,
    conversationId?: string | null,
  ) => void;
  /** Stamp the current execution id onto the last assistant message (on
   * `run_plan` for a multi-agent turn). Marks the turn as team-driven so its
   * bubble defers the cost row to the team card (§7.3A, avoids double display).
   * No-op if already set or there is no assistant message. */
  setLastAssistantExecutionId: (
    executionId: string,
    conversationId?: string | null,
  ) => void;
  setGenerating: (v: boolean, conversationId?: string | null) => void;
  clearMessages: () => void;
  switchConversation: (id: string | null) => void;
  /** Release a finished background turn's buffer. When a turn completes while
   * the user is on *another* conversation, the slice it streamed into is now
   * idle, but no switch event will reclaim it — so the turn pipeline calls this
   * on its terminal events (`message_end` / inline `error`). Drops the slice
   * only when `conversationId` is **not** the active conversation and is idle
   * (no live turn, no pending approval), mirroring {@link switchConversation}'s
   * release-on-leave so the memory bound stays "active + N *running* background
   * turns"; the page load guard reloads it from the server on return. No-op for
   * the active or a still-busy conversation. */
  releaseBackgroundSlice: (conversationId: string) => void;
  /** Register the controller for the current turn (cleared when it ends). */
  setAbort: (a: AbortController | null, conversationId?: string | null) => void;
  /** Abort the in-flight turn and finalize the streaming message. */
  stopGeneration: () => void;
  setError: (
    message: string,
    retry: (() => void) | null,
    conversationId?: string | null,
    action?: ErrorAction | null,
  ) => void;
  clearError: (conversationId?: string | null) => void;
  /** Scroll the conversation to a message and flash it. Bumps a nonce so
   * re-focusing the same id re-triggers the effect; no-op visuals if the id is
   * not currently rendered. */
  focusMessage: (id: string) => void;
  /** Record a search-hit jump to honor after the target conversation loads
   * (used when navigating in from another conversation). */
  requestMessageFocus: (conversationId: string, messageId: string) => void;
  /** Clear the pending search-hit jump (once consumed). */
  clearPendingFocus: () => void;
}

export const useConversationStore = create<ConversationState>((set, get) => {
  /** Update one conversation's runtime slice (the active one when the id is
   * omitted), lazily created. Return null from `update` for a no-op (leaves
   * `byId` untouched). */
  const patchConversation = (
    conversationId: string | null | undefined,
    update: (rt: ConversationRuntime) => Partial<ConversationRuntime> | null,
  ): void =>
    set((state) => {
      const key = conversationId ?? state.currentConversationId ?? DRAFT_KEY;
      const cur = state.byId[key] ?? EMPTY_RUNTIME;
      const patch = update(cur);
      if (!patch) return {};
      return { byId: { ...state.byId, [key]: { ...cur, ...patch } } };
    });

  /** Update the active conversation's runtime slice. */
  const patchActive = (
    update: (rt: ConversationRuntime) => Partial<ConversationRuntime> | null,
  ): void => patchConversation(undefined, update);

  return {
    currentConversationId: null,
    byId: {},
    pendingFocus: null,

    setCurrentConversation: (id) => set({ currentConversationId: id }),

    dropConversationRuntime: (id) =>
      set((state) => {
        const byId = { ...state.byId };
        delete byId[id];
        return {
          currentConversationId:
            state.currentConversationId === id
              ? null
              : state.currentConversationId,
          byId,
        };
      }),

    setMessages: (messages) => patchActive(() => ({ messages })),

    setMessageWindow: (messages, flags, conversationId) =>
      patchConversation(conversationId, () => ({
        messages,
        hasMoreBefore: flags.hasMoreBefore,
        hasMoreAfter: flags.hasMoreAfter,
      })),

    prependMessages: (older, hasMoreBefore, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (older.length === 0) return { hasMoreBefore };
        const known = new Set(rt.messages.map((m) => m.id));
        const fresh = older.filter((m) => !known.has(m.id));
        return { messages: [...fresh, ...rt.messages], hasMoreBefore };
      }),

    appendNewerMessages: (newer, hasMoreAfter, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (newer.length === 0) return { hasMoreAfter };
        const known = new Set(rt.messages.map((m) => m.id));
        const fresh = newer.filter((m) => !known.has(m.id));
        return { messages: [...rt.messages, ...fresh], hasMoreAfter };
      }),

    setLoadingOlder: (v, conversationId) =>
      patchConversation(conversationId, () => ({ loadingOlder: v })),

    setLoadingNewer: (v, conversationId) =>
      patchConversation(conversationId, () => ({ loadingNewer: v })),

    addMessage: (message, conversationId) =>
      patchConversation(conversationId, (rt) => ({
        messages: [...rt.messages, message],
      })),

    appendToLastMessage: (chunk, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last) return null;
        messages[messages.length - 1] = {
          ...last,
          content: last.content + chunk,
          // Fold the reply text into the single-agent process timeline (in arrival
          // order, after any preceding 思考/工具 step) so it renders inline at its
          // true chronological position (前端UX设计.md §一B); `content` above stays
          // the canonical full text for copy / citations.
          process: appendContentStep(last.process, chunk),
          // The captain is writing its answer now → any「正在生成工具」line is done.
          composingTool: null,
        };
        return { messages };
      }),

    appendReasoningToLastMessage: (chunk, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last) return null;
        // Keep the reasoning blob (multi-agent ThinkingPanel / copy / back-compat)
        // AND fold it into the single-agent process timeline, in arrival order, so
        // it interleaves with this turn's tool steps.
        messages[messages.length - 1] = {
          ...last,
          reasoning: (last.reasoning ?? "") + chunk,
          process: appendReasoningStep(last.process, chunk),
        };
        return { messages };
      }),

    setComposingTool: (tool, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        messages[messages.length - 1] = { ...last, composingTool: tool };
        return { messages };
      }),

    addProcessTool: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        messages[messages.length - 1] = {
          ...last,
          process: appendToolStep(last.process, payload),
          // The composed call is now executing → its real process step replaces the
          // transient「正在生成」line.
          composingTool: null,
        };
        return { messages };
      }),

    endProcessTool: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return null;
        const process = resolveToolStep(last.process, payload);
        if (process === last.process) return null;
        messages[messages.length - 1] = { ...last, process };
        return { messages };
      }),

    attachCitationsToLastMessage: (citations, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (citations.length === 0) return null;
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          messages[messages.length - 1] = { ...last, citations };
        }
        return { messages };
      }),

    attachErrorToLastMessage: (error, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          messages[messages.length - 1] = { ...last, error };
        }
        return { messages };
      }),

    attachCostToLastMessage: (cost, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant") {
          messages[messages.length - 1] = { ...last, cost };
        }
        return { messages };
      }),

    addCheckpoint: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            idx = i;
            break;
          }
        }
        if (idx === -1) return null;
        const msg = messages[idx];
        const existing = msg.checkpoints ?? [];
        // A re-delivered event must not stack a second card for one checkpoint.
        if (existing.some((c) => c.id === payload.checkpoint_id)) return null;
        messages[idx] = {
          ...msg,
          checkpoints: [
            ...existing,
            {
              id: payload.checkpoint_id,
              question: payload.question,
              context: payload.context ?? "",
              assumptions: payload.assumptions ?? [],
              questions: payload.questions ?? [],
              styleOptions: payload.style_options ?? [],
              status: "pending",
              decision: null,
              note: "",
              selected: [],
            },
          ],
        };
        return { messages };
      }),

    addNonBlockingAsk: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            idx = i;
            break;
          }
        }
        if (idx === -1) return null;
        const msg = messages[idx];
        const existing = msg.nonBlockingAsks ?? [];
        // A re-delivered event must not stack a second card for one ask.
        if (existing.some((a) => a.id === payload.ask_id)) return null;
        messages[idx] = {
          ...msg,
          nonBlockingAsks: [
            ...existing,
            {
              id: payload.ask_id,
              question: payload.question,
              context: payload.context ?? "",
              assumptions: payload.assumptions ?? [],
              questions: payload.questions ?? [],
              styleOptions: payload.style_options ?? [],
            },
          ],
        };
        return { messages };
      }),

    settleCheckpoint: (
      checkpointId,
      decision,
      note,
      selected,
      conversationId,
    ) =>
      patchConversation(conversationId, (rt) => {
        let changed = false;
        const messages = rt.messages.map((m) => {
          if (!m.checkpoints?.some((c) => c.id === checkpointId)) return m;
          changed = true;
          return {
            ...m,
            checkpoints: m.checkpoints.map((c) =>
              c.id === checkpointId
                ? {
                    ...c,
                    status: "resolved" as const,
                    decision,
                    note,
                    selected,
                  }
                : c,
            ),
          };
        });
        return changed ? { messages } : null;
      }),

    addPlanReview: (payload, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            idx = i;
            break;
          }
        }
        if (idx === -1) return null;
        const msg = messages[idx];
        const existing = msg.planReviews ?? [];
        // A re-delivered event must not stack a second card for one checkpoint.
        if (existing.some((c) => c.id === payload.checkpoint_id)) return null;
        messages[idx] = {
          ...msg,
          planReviews: [
            ...existing,
            {
              id: payload.checkpoint_id,
              steps: payload.steps ?? [],
              pending: payload.pending ?? [],
              status: "pending",
              decision: null,
              note: "",
            },
          ],
        };
        return { messages };
      }),

    settlePlanReview: (checkpointId, decision, note, conversationId) =>
      patchConversation(conversationId, (rt) => {
        let changed = false;
        const messages = rt.messages.map((m) => {
          if (!m.planReviews?.some((c) => c.id === checkpointId)) return m;
          changed = true;
          return {
            ...m,
            planReviews: m.planReviews.map((c) =>
              c.id === checkpointId
                ? { ...c, status: "resolved" as const, decision, note }
                : c,
            ),
          };
        });
        return changed ? { messages } : null;
      }),

    createAssistantMessage: (conversationId) => {
      const id = crypto.randomUUID();
      patchConversation(conversationId, (rt) => ({
        messages: [
          ...rt.messages,
          {
            id,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            executionId: null,
            isStreaming: true,
          },
        ],
        isGenerating: true,
      }));
      return id;
    },

    finalizeLastMessage: (conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        const last = messages[messages.length - 1];
        if (last) {
          messages[messages.length - 1] = {
            ...last,
            isStreaming: false,
            composingTool: null,
          };
        }
        return { messages, isGenerating: false };
      }),

    updateMessage: (id, update) =>
      patchActive((rt) => ({
        messages: rt.messages.map((m) =>
          m.id === id ? { ...m, ...update } : m,
        ),
      })),

    removeMessage: (id, conversationId) =>
      patchConversation(conversationId, (rt) => {
        if (!rt.messages.some((m) => m.id === id)) return null;
        return { messages: rt.messages.filter((m) => m.id !== id) };
      }),

    truncateAfter: (id, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const idx = rt.messages.findIndex((m) => m.id === id);
        if (idx === -1) return null;
        // Regenerate / edit re-runs from this message: the backend drops every
        // later row, so the window now reaches the (new) tail — clear any stale
        // hasMoreAfter left by a search-hit jump so the turn streams at the head.
        return {
          messages: rt.messages.slice(0, idx + 1),
          hasMoreAfter: false,
        };
      }),

    reconcileLastTurn: (userMessageId, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            messages[i] = { ...messages[i], id: userMessageId };
            break;
          }
        }
        return { messages };
      }),

    setLastAssistantExecutionId: (executionId, conversationId) =>
      patchConversation(conversationId, (rt) => {
        const messages = [...rt.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            if (messages[i].executionId === executionId) return null;
            messages[i] = { ...messages[i], executionId };
            return { messages };
          }
        }
        return null;
      }),

    setGenerating: (v, conversationId) =>
      patchConversation(conversationId, () => ({ isGenerating: v })),

    clearMessages: () =>
      patchActive(() => ({
        messages: [],
        isGenerating: false,
        messageFocus: null,
        hasMoreBefore: false,
        hasMoreAfter: false,
      })),

    switchConversation: (id) => {
      const prevKey = get().currentConversationId ?? DRAFT_KEY;
      const nextKey = id ?? DRAFT_KEY;
      // Re-selecting the open conversation is a pointer no-op — never disturb a
      // live turn by resetting its slice.
      if (prevKey === nextKey) {
        set({ currentConversationId: id });
        return;
      }
      set((state) => {
        const byId = { ...state.byId };
        // Leaving prev no longer aborts it: a turn keeps streaming into its own
        // slice in the background (it routes by conversationId now, not the
        // active key). Release the buffer only when prev is idle — no live turn
        // AND no pending approval — so memory stays bounded (= active + N live
        // background turns); an idle conversation reloads from the server on
        // return. A busy slice (or one with a paused approval) is kept alive.
        const prev = byId[prevKey];
        const prevBusy =
          !!prev?.isGenerating ||
          useApprovalStore
            .getState()
            .pending.some((p) => p.conversationId === prevKey);
        if (!prevBusy) delete byId[prevKey];
        // Entering next: keep a live background slice as-is so its in-flight (or
        // just-completed) messages survive; only seed an empty runtime when
        // nothing is buffered, so the page's load guard reloads history.
        if (!byId[nextKey]) byId[nextKey] = { ...EMPTY_RUNTIME };
        return { currentConversationId: id, byId };
      });
    },

    releaseBackgroundSlice: (conversationId) =>
      set((state) => {
        // Never release what is on screen — it would blank the view.
        const activeKey = state.currentConversationId ?? DRAFT_KEY;
        if (conversationId === activeKey) return {};
        const slice = state.byId[conversationId];
        if (!slice) return {};
        // Same "busy" test as switchConversation's release-on-leave, kept here so
        // the single idle predicate (no live turn AND no pending approval) does
        // not drift between the two release sites.
        const busy =
          slice.isGenerating ||
          useApprovalStore
            .getState()
            .pending.some((p) => p.conversationId === conversationId);
        if (busy) return {};
        const byId = { ...state.byId };
        delete byId[conversationId];
        return { byId };
      }),

    setAbort: (a, conversationId) =>
      patchConversation(conversationId, () => ({ abort: a })),

    stopGeneration: () => {
      activeRuntime(get()).abort?.abort();
      patchActive(() => ({ abort: null }));
      get().finalizeLastMessage();
      // Aborting cuts the stream before any `approval_resolved`, so a paused tool
      // call would otherwise leave this conversation's prompt stranded — clear it
      // (other conversations' prompts are untouched).
      useApprovalStore
        .getState()
        .clear(get().currentConversationId ?? DRAFT_KEY);
      // The abort skips message_end, so a multi-agent execution would otherwise
      // stay "running" forever — mark this turn's graph cancelled (by its live
      // assistant message id) so the task card leaves its live state and offers
      // a re-run.
      const mid = lastAssistantMessageId(activeRuntime(get()).messages);
      if (mid) {
        const exec = useExecutionStore.getState();
        const rt = execRuntime(exec, mid);
        if (rt.plan && rt.status === "running")
          exec.setStatus("cancelled", mid);
      }
    },

    setError: (message, retry, conversationId, action) =>
      patchConversation(conversationId, () => ({
        error: message,
        retry,
        errorAction: action ?? null,
      })),

    clearError: (conversationId) =>
      patchConversation(conversationId, () => ({
        error: null,
        retry: null,
        errorAction: null,
      })),

    focusMessage: (id) =>
      patchActive((rt) => ({
        messageFocus: { id, nonce: (rt.messageFocus?.nonce ?? 0) + 1 },
      })),

    requestMessageFocus: (conversationId, messageId) =>
      set({ pendingFocus: { conversationId, messageId } }),

    clearPendingFocus: () => set({ pendingFocus: null }),
  };
});

// ---- active-slice accessors ----
// Components read the *active* conversation's runtime through these, so the
// keyed store shape stays an implementation detail. Each selects a primitive /
// stable reference, so a component only re-renders when its own field changes.

/** Messages of the active conversation. */
export const useActiveMessages = (): Message[] =>
  useConversationStore((s) => activeRuntime(s).messages);

/** Whether the active conversation has an in-flight turn. */
export const useActiveGenerating = (): boolean =>
  useConversationStore((s) => activeRuntime(s).isGenerating);

/** Whether a *specific* conversation has an in-flight turn. The sidebar status
 * dot reads this (not {@link useActiveGenerating}) so a background turn that
 * keeps streaming after the user switches away still lights up — a released
 * idle slice reports false, which is correct (no live turn). */
export const useConversationGenerating = (conversationId: string): boolean =>
  useConversationStore((s) => runtimeOf(s, conversationId).isGenerating);

/** The active conversation's last-turn error banner text, if any. */
export const useActiveError = (): string | null =>
  useConversationStore((s) => activeRuntime(s).error);

/** The retry closure for the active conversation's failed turn, if any. */
export const useActiveRetry = (): (() => void) | null =>
  useConversationStore((s) => activeRuntime(s).retry);

/** The active conversation's error remedy action (e.g. "去配置"), if any. */
export const useActiveErrorAction = (): ErrorAction | null =>
  useConversationStore((s) => activeRuntime(s).errorAction);

/** The active conversation's scroll-to-and-flash target, if any. */
export const useActiveMessageFocus = (): { id: string; nonce: number } | null =>
  useConversationStore((s) => activeRuntime(s).messageFocus);

/** Whether older messages remain above the active conversation's window. */
export const useActiveHasMoreBefore = (): boolean =>
  useConversationStore((s) => activeRuntime(s).hasMoreBefore);

/** Whether newer messages remain below the active conversation's window
 * (true only after a search-hit jump into history). */
export const useActiveHasMoreAfter = (): boolean =>
  useConversationStore((s) => activeRuntime(s).hasMoreAfter);

/** Whether an older-page fetch is in flight (drives the top spinner). */
export const useActiveLoadingOlder = (): boolean =>
  useConversationStore((s) => activeRuntime(s).loadingOlder);

/** Whether a newer-page fetch is in flight (drives the bottom spinner). */
export const useActiveLoadingNewer = (): boolean =>
  useConversationStore((s) => activeRuntime(s).loadingNewer);

/** Imperative read of the active conversation's runtime (outside React). */
export const getActiveRuntime = (): ConversationRuntime =>
  activeRuntime(useConversationStore.getState());

/** Imperative read of a specific conversation's runtime (outside React) — used
 * by the turn pipeline to inspect a background turn's slice by id. */
export const getRuntime = (
  conversationId?: string | null,
): ConversationRuntime =>
  runtimeOf(useConversationStore.getState(), conversationId);
