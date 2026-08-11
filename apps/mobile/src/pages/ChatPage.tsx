import { getAutonomy } from "@/api/autonomy";
import { listBrowserSessions } from "@/api/browserSessions";
import { getTokens } from "@/api/client";
import {
  type MemoryUpdate,
  type MessageDetail,
  createConversation,
  getConversation,
  getMessages,
  setConversationModelProfile,
} from "@/api/conversations";
import { sendMidFlightMessage } from "@/api/midFlight";
import {
  getLastModelProfileId,
  profileDisplayLabel,
  setLastModelProfileId,
  useModelProfiles,
} from "@/api/modelProfiles";
import {
  DEFAULT_PERMISSION_AXES,
  type PermissionAxes,
  axesShortLabel,
  normalizeAxes,
  recipeToAxes,
} from "@/api/permissionAxes";
import { resolveStageCardStream } from "@/api/stageCard";
import {
  type ResumeTurnBody,
  type TeamPreviewAmendments,
  attachStream,
  regenerateStream,
  resumeStream,
  streamMessage,
} from "@/api/stream";
import {
  type PausedTurnSummary,
  type PendingInteractionSummary,
  type TurnRecovery,
  getRecovery,
  stopConversation,
} from "@/api/turn";
import { getMessageCostDisplay } from "@/api/usage";
import {
  AssistantContent,
  SupportDiagnosticCopyButton,
} from "@/components/AssistantView";
import { BrowserLiveSheet } from "@/components/BrowserLiveSheet";
import type { OpenBrowserLiveOpts } from "@/components/BrowserLoginDecisionCard";
import { CollapsibleUserText } from "@/components/CollapsibleUserText";
import { ComposerMoreSheet } from "@/components/ComposerMoreSheet";
import { ConversationDrawer } from "@/components/ConversationDrawer";
import { DelegationAuthorizationCard } from "@/components/DelegationAuthorizationCard";
import { FileArtifactsCard } from "@/components/FileArtifactsCard";
import { MemoryUpdateCard } from "@/components/MemoryUpdateCard";
import { ModelPicker } from "@/components/ModelPicker";
import { PauseCard } from "@/components/PauseCard";
import { PermissionAxesSheet } from "@/components/PermissionAxesSheet";
import { QueuedTurnsBar } from "@/components/QueuedTurnsBar";
import { ResumeCard } from "@/components/ResumeCard";
import { StageCard } from "@/components/StageCard";
import { EscalationAnswer } from "@/components/TeamView";
import { VoiceButton, VoiceRecordingBar } from "@/components/VoiceInput";
import {
  type MessageAttachment,
  finalizeAttachmentsForSend,
  hasSendableDraft,
  prepareAttachment,
} from "@/lib/attachments";
import {
  applyColdInteractionWireEvent,
  bindEmptyColdMessageId,
  clearColdInteractions,
  getColdInteraction,
  isColdResumeKind,
  kindFromColdRequiredEvent,
  kindFromColdResolvedEvent,
  listColdPending,
  markColdDeferred,
  markColdResolved,
  markColdSubmitting,
  rekeyColdMessageId,
  reopenColdPending,
  upsertColdRequired,
  useColdInteractions,
} from "@/lib/coldInteractions";
import {
  type ColdResumeHost,
  pausedSummaryToRequiredPayload,
  resolveColdBindHostId,
  selectVisibleColdResumes,
} from "@/lib/coldResume";
import { composerTrailingSlots } from "@/lib/composerTrailing";
import {
  type ErrorAction,
  StreamHttpError,
  degradedFinishChipLabel,
  describeStreamHttpError,
  emptyChatCopy,
  errorActionForCode,
  resolveEmptyFailureNotice,
} from "@/lib/errors";
import { resolveArtifactsForTurn } from "@/lib/fileArtifacts";
import {
  type MessageDelivery,
  defaultDelivery,
  isLiveInterruptible,
} from "@/lib/messageDelivery";
import {
  type QueuedTurnEntry,
  listQueuedTurns,
  removeQueuedTurn,
  upsertQueuedTurn,
} from "@/lib/queuedTurns";
import {
  QUEUE_DROPPED_HINT,
  reconcileQueuedTurns,
} from "@/lib/reconcileQueuedTurns";
import { clearLiveTurnEvents, removeLiveTurn } from "@/lib/reconnectLiveTurn";
import {
  createHarvestRefreshScheduler,
  dropSettledLiveTurns,
} from "@/lib/refreshAfterExecutionCompleted";
import { prepareResumePausedTurn } from "@/lib/resumePausedTurn";
import {
  STOP_FAILED_MESSAGE,
  type StopUiPhase,
  allowsEventWhileStopping,
  isStopBusy,
  isStopConfirmEvent,
  reduceStopPhase,
  stopButtonLabel,
} from "@/lib/stopLifecycle";
import {
  type SupportDiagnosticIds,
  extractSupportIdsFromEvents,
} from "@/lib/supportDiagnostics";
import { useStickScroll } from "@/lib/useStickScroll";
import { useVoiceInput } from "@/lib/useVoiceInput";
import {
  type EscalationSlotEsc,
  extractAsks,
  extractEscalationSlots,
  extractEvidenceLedger,
  extractGraphAppendActKinds,
  extractGraphAppendAuthorizedBy,
  extractHotDecisionTraces,
  extractPrevExecutionIds,
  extractRunToolCalls,
  extractStageCardTraces,
  extractToolPhases,
  extractWorkerToolPhases,
  fold,
} from "@/protocol/fold";
import type {
  CheckpointDecision,
  DebateNarrativeRound,
  ErrorPayload,
  MessageEndPayload,
  MessageStartPayload,
  ResumeDeferredPayload,
  SSEEvent,
  TurnQueueCancelledPayload,
  TurnQueueStartedPayload,
  TurnQueuedPayload,
  TurnWarningPayload,
  UsageBreakdown,
} from "@agentcore/contract-types";
import type {
  ProjectedInteraction,
  ProjectedTurn,
} from "@agentcore/protocol-conformance";
import {
  ArrowDown,
  Folder,
  Loader2,
  Menu,
  Send,
  Square,
  SquarePen,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";

// One-shot handoff from a draft send (at `/`) to the freshly-created conversation's first
// stream (at `/c/:id`). 直接对话: the 对话 tab opens a draft (no server conversation); the
// first send lazily creates one, routes to /c/:id, and the remounted ChatPage picks this up
// to POST+stream that first message (rather than re-attaching to a not-yet-existing run).
// Lives outside React so it survives the / → /c/:id remount; cleared on consume, and a hard
// refresh simply finds it empty (the unsent draft is gone — acceptable).
let pendingFirstSend: {
  id: string;
  text: string;
  attachments: MessageAttachment[];
} | null = null;

// A turn streamed this session. `userText === null` for a turn whose user bubble already
// lives in the persisted history (a reattach on reopen / a durable resume) — only its
// assistant side streams live; a fresh send carries its own user text.
interface Turn {
  id: string;
  userText: string | null;
  events: SSEEvent[];
  // Display-only chips for files this turn carried (text inline and/or workspace resident).
  attachments?: { name: string; truncated?: boolean }[];
}

/** Attachment context chips on a user bubble (no download — text rode the send body and/or
 *  bytes were resided into the conversation workspace). `已截断` flags text capped at 256KB. */
function AttachmentChips({
  items,
}: {
  items: { name: string; truncated?: boolean }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="attach-chips">
      {items.map((a, i) => (
        <span key={`${a.name}-${i}`} className="attach-chip">
          <span aria-hidden>📎</span>
          <span className="attach-chip-name">{a.name}</span>
          {a.truncated && <span className="attach-chip-trunc">已截断</span>}
        </span>
      ))}
    </div>
  );
}

/** 主时间线用户气泡（排队期不插泡；出队开跑后再出现）。 */
function UserTurnBubble({ turn }: { turn: Turn }) {
  if (turn.userText === null) return null;
  return (
    <div className="bubble user">
      <CollapsibleUserText contentKey={turn.userText}>
        {turn.userText}
      </CollapsibleUserText>
      <AttachmentChips items={turn.attachments ?? []} />
    </div>
  );
}

/** Live 回合时钟：优先 message_start.timestamp，否则首帧。 */
function extractTurnClock(events: SSEEvent[]): string | null {
  for (const e of events) {
    if (e.type === "message_start" && e.timestamp) return e.timestamp;
  }
  return events[0]?.timestamp ?? null;
}

/** message_end + error 旁路元数据（用量 / 轮次 / 收尾 / 诊断）— 不入 ProjectedTurn. */
function extractTurnChrome(events: SSEEvent[]): {
  usage: UsageBreakdown | null;
  rounds: number | null;
  durationMs: number | null;
  finishReason: string | null;
  emptyDiagnosis: string | undefined;
  bodyKind: string | undefined;
  baseUrl: string | undefined;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  credentialSource: string | null | undefined;
} {
  let usage: UsageBreakdown | null = null;
  let rounds: number | null = null;
  let durationMs: number | null = null;
  let finishReason: string | null = null;
  let emptyDiagnosis: string | undefined;
  let bodyKind: string | undefined;
  let baseUrl: string | undefined;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let credentialSource: string | null | undefined;
  for (const e of events) {
    if (e.type === "error") {
      const p = e.payload as ErrorPayload;
      errorCode = p.code;
      errorMessage = p.message;
      emptyDiagnosis = p.context?.empty_diagnosis;
      bodyKind = p.context?.body_kind;
      baseUrl = p.context?.base_url;
      credentialSource = p.context?.credential_source;
    }
    if (e.type === "message_end") {
      const p = e.payload as MessageEndPayload;
      finishReason = p.finish_reason;
      rounds = typeof p.rounds === "number" ? p.rounds : null;
      durationMs =
        typeof p.duration_ms === "number" && p.duration_ms > 0
          ? p.duration_ms
          : null;
      if (p.usage) {
        usage = {
          input: p.usage.input_tokens,
          output: p.usage.output_tokens,
          reasoning: p.usage.reasoning_tokens,
          cache_hit: p.usage.cache_hit_tokens,
          cache_miss: p.usage.cache_miss_tokens,
        };
      }
    }
  }
  return {
    usage,
    rounds,
    durationMs,
    finishReason,
    emptyDiagnosis,
    bodyKind,
    baseUrl,
    errorCode,
    errorMessage,
    credentialSource,
  };
}

/** Error extras for「复制排查包」(SSE ErrorContext; cold RunError only has code). */
function supportErrorExtras(opts: {
  errorCode?: string | null;
  emptyDiagnosis?: string | null;
  bodyKind?: string | null;
  baseUrl?: string | null;
}): Pick<
  SupportDiagnosticIds,
  "errorCode" | "emptyDiagnosis" | "bodyKind" | "baseUrl" | "stream"
> {
  const errorCode = opts.errorCode?.trim() || undefined;
  const emptyDiagnosis = opts.emptyDiagnosis?.trim() || undefined;
  const bodyKind = opts.bodyKind?.trim() || undefined;
  const baseUrl = opts.baseUrl?.trim() || undefined;
  const stream =
    !!emptyDiagnosis || errorCode === "LLM_EMPTY_RESPONSE" ? true : undefined;
  return { errorCode, emptyDiagnosis, bodyKind, baseUrl, stream };
}

/** Build 排查包 ids for a history assistant row (REST trace_id + journal execution_id). */
function historySupportIds(
  m: MessageDetail,
  conversationId: string | null,
  extras?: ReturnType<typeof supportErrorExtras>,
): SupportDiagnosticIds {
  const fromEvents = m.runs?.events?.length
    ? extractSupportIdsFromEvents(m.runs.events)
    : {};
  let executionId = fromEvents.executionId;
  if (!executionId && m.runs?.process) {
    for (const s of m.runs.process) {
      if (s.kind === "team" && s.execution_id) {
        executionId = s.execution_id;
        break;
      }
    }
  }
  return {
    conversationId,
    messageId: m.id,
    traceId: m.trace_id ?? fromEvents.traceId,
    executionId,
    ...extras,
  };
}

// A run keeps running detached after a dropped connection (执行与请求解耦 C1 · slice 1a),
// so a transport drop reconnects (rejoins the live run), never resends.
const RECONNECT_BANNER = "连接中断，回合仍在后台继续。点「重连」继续查看。";

/** A turn-level error with an optional one-tap reconnect (a held SSE that dropped while
 *  the run lives on), or a config remedy (e.g.「去配置」→ 模型配置 for LLM_KEY_REQUIRED).
 *  /stop 失败只出诚实文案，可再点停止按钮（无「重试停止」专属路径）。 */
interface ChatError {
  text: string;
  reconnect?: boolean;
  action?: ErrorAction;
}

/** The user's 停止 (abort button), never surfaced as an error. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Format an integer nano-CNY cost as ¥ caption (1 元 = 1e9). Returns null for
 *  0 / unknown so a free turn shows nothing, never「¥0.00」(§7.5). BYOK estimates get ≈. */
function formatCost(
  nanoCny: number | null | undefined,
  estimated = false,
): string | null {
  if (!nanoCny || nanoCny <= 0) return null;
  const yuan = nanoCny / 1e9;
  const body = yuan < 0.01 ? "<¥0.01" : `¥${yuan.toFixed(yuan < 0.1 ? 4 : 2)}`;
  return estimated ? `≈${body} 自带密钥·估算` : body;
}

type CachedDisplayMoney = {
  nano: number;
  estimated: boolean;
  /** BYOK 社区价目未命中（pricing_source=unpriced）：显式标注，金额不出数。 */
  unpriced?: boolean;
};

/** 未计价标注文案（拍板 2026-07-20，与桌面 COST_UNPRICED_LABEL 同口径）。 */
const COST_UNPRICED_LABEL = "自带密钥·未计价";

// A reloaded turn carries no cost in its MessageDetail (the ledger is the truth source);
// fetch it lazily per message, cached module-wide so re-renders / re-opens don't refetch.
const costCache = new Map<string, CachedDisplayMoney>();
const costInflight = new Set<string>();

/** Lazily fetch a persisted turn's cost when its bubble scrolls into view (Intersection
 *  Observer — avoids an open-time request storm over a whole window). Returns the cached
 *  display money; supplementary, so a failure just leaves the row uncosted. */
function useLazyMessageCost(messageId: string): {
  ref: React.RefObject<HTMLDivElement | null>;
  money: CachedDisplayMoney | null;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [money, setMoney] = useState<CachedDisplayMoney | null>(
    () => costCache.get(messageId) ?? null,
  );
  useEffect(() => {
    if (!messageId) return;
    if (costCache.has(messageId)) {
      setMoney(costCache.get(messageId) ?? null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      if (costCache.has(messageId)) {
        setMoney(costCache.get(messageId) ?? null);
        return;
      }
      if (costInflight.has(messageId)) return;
      costInflight.add(messageId);
      getMessageCostDisplay(messageId)
        .then((t) => {
          if (!t) return;
          costCache.set(messageId, t);
          setMoney(t);
        })
        .finally(() => costInflight.delete(messageId));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [messageId]);
  return { ref, money };
}

function recoveredApprovalPending(
  a: PendingInteractionSummary,
): Extract<ProjectedInteraction, { kind: "approval" }> | null {
  if (a.kind !== "approval") return null;
  const p = a.payload ?? {};
  return {
    kind: "approval",
    id: a.id,
    status: "pending",
    toolCallId: typeof p.tool_call_id === "string" ? p.tool_call_id : a.id,
    toolName: typeof p.tool_name === "string" ? p.tool_name : "tool",
    arguments: (p.arguments as Record<string, unknown>) ?? {},
  };
}

function recoveredDelegation(
  a: PendingInteractionSummary,
): Extract<ProjectedInteraction, { kind: "delegation_authorization" }> | null {
  if (a.kind !== "delegation_authorization") return null;
  const p = a.payload ?? {};
  const workers = Array.isArray(p.workers)
    ? (p.workers as Array<Record<string, unknown>>)
    : [];
  const tools = Array.isArray(p.tools)
    ? p.tools.filter((t): t is string => typeof t === "string")
    : [];
  return {
    kind: "delegation_authorization",
    id: a.id,
    status: "pending",
    executionId: typeof p.execution_id === "string" ? p.execution_id : "",
    workers,
    tools,
  };
}

function recoveredStageCard(
  a: PendingInteractionSummary,
): Extract<ProjectedInteraction, { kind: "stage_card" }> | null {
  if (a.kind !== "stage_card") return null;
  const p = a.payload ?? {};
  const sides = Array.isArray(p.sides)
    ? (p.sides as Array<Record<string, unknown>>).map((s) => ({
        key: typeof s.key === "string" ? s.key : "",
        name: typeof s.name === "string" ? s.name : "",
        stance: typeof s.stance === "string" ? s.stance : "",
      }))
    : [];
  const ptrs = Array.isArray(p.fact_pointers)
    ? p.fact_pointers.filter((x): x is string => typeof x === "string")
    : [];
  return {
    kind: "stage_card",
    id: a.id,
    status: "pending",
    motion: typeof p.motion === "string" ? p.motion : "",
    sides,
    form: typeof p.form === "string" ? p.form : "debate",
    rationale: typeof p.rationale === "string" ? p.rationale : "",
    factPointers: ptrs,
    thorough: p.thorough !== false,
    maxRounds: Number(p.max_rounds ?? 5) || 5,
    note: typeof p.note === "string" ? p.note : null,
  };
}

/** Cold recovery · pending escalation → EscalationAnswer card body. */
function recoveredEscalation(a: PendingInteractionSummary): {
  id: string;
  runId: string;
  esc: EscalationSlotEsc;
} | null {
  if (a.kind !== "escalation") return null;
  const p = a.payload ?? {};
  if (p.awaiting === "ceo") return null;
  const question = typeof p.question === "string" ? p.question.trim() : "";
  if (!question) return null;
  const assumption = typeof p.assumption === "string" ? p.assumption : "";
  const runId = typeof p.run_id === "string" ? p.run_id : "";
  const kindRaw = p.kind;
  const kind =
    kindRaw === "scope" || kindRaw === "dep" ? kindRaw : ("normal" as const);
  return {
    id: a.id,
    runId,
    esc: {
      question,
      assumption,
      blocking: true,
      status: "pending",
      answer: null,
      kind,
      ...(p.awaiting === "user" ? { awaiting: "user" as const } : {}),
      ...(p.browser_login === true ? { browserLogin: true as const } : {}),
    },
  };
}

/** One-line status derived from the projected turn — proves the fold drives the UI
 * (进度 / 工具 are read off ProjectedTurn, not re-parsed from events). A `paused` turn
 * returns null: its actionable surface owns the view instead — an `approval` pause shows the
 * PauseCard above the composer, while 挂起即收口 (②, Phase 3) a checkpoint / plan_review pause
 * finalizes the turn and shows the durable ResumeCard below it. */
function summarize(p: ProjectedTurn): string | null {
  if (p.status === "paused") return null;
  if (p.runs.length > 0) {
    const running = p.runs.filter((r) => r.status === "running").length;
    return `团队 ${p.progress.completed}/${p.progress.total} 完成${running ? ` · ${running} 进行中` : ""}`;
  }
  const tool = [...p.process].reverse().find((s) => s.kind === "tool");
  if (tool && tool.kind === "tool" && tool.status === "running")
    return `正在调用 ${tool.tool_name}…`;
  if (p.status === "failed") return "出错了";
  // 单 Agent 空停：聊天时间线不占「已停止」(P1)；多 Agent 走 TeamView 头。
  return null;
}

function extractTurnWarning(events: SSEEvent[]): string | null {
  for (const e of events) {
    if (e.type === "turn_warning") {
      return (e.payload as TurnWarningPayload).message;
    }
  }
  return null;
}

/** Live / journal：``message_start.message_id``（客户端 turn.id 是本地 UUID，不能当云 messageId）。 */
function extractMessageId(events: SSEEvent[]): string | null {
  for (const e of events) {
    if (e.type === "message_start") {
      return (e.payload as MessageStartPayload).message_id;
    }
  }
  return null;
}

function AssistantBubble({
  turn,
  live,
  conversationId,
  onFill,
  onOpenBrowserLive,
  onRetry,
}: {
  turn: Turn;
  live: boolean;
  conversationId: string | null;
  onFill: (text: string) => void;
  onOpenBrowserLive?: (opts?: OpenBrowserLiveOpts) => void;
  onRetry?: () => void;
}) {
  const navigate = useNavigate();
  const p = useMemo(() => fold(turn.events), [turn.events]);
  const messageId = useMemo(() => extractMessageId(turn.events), [turn.events]);
  const chrome = useMemo(() => extractTurnChrome(turn.events), [turn.events]);
  // 主清单优先 delivery_status；缺字段时回落 process/events（A1 旁路同源）。
  const { list: artifacts, review: reviewArtifacts } = useMemo(
    () =>
      resolveArtifactsForTurn({
        deliveryStatus: p.deliveryStatus,
        process: p.process,
        events: turn.events,
      }),
    [p.deliveryStatus, p.process, turn.events],
  );
  // 非阻塞提问卡内容：随时间线 `ask` 标记原位呈现（旁路读原始事件，不入 ProjectedTurn）。
  const asks = useMemo(() => extractAsks(turn.events), [turn.events]);
  // 升级时间线槽（统一时间线二期）: escalation_id → card body（旁路；golden escalations 不加 id）。
  const escalationSlots = useMemo(
    () => extractEscalationSlots(turn.events),
    [turn.events],
  );
  // 热审批/委派授权痕迹 (D3): resolved 轻行内容（旁路读原始事件）。
  const hotTraces = useMemo(
    () => extractHotDecisionTraces(turn.events),
    [turn.events],
  );
  const stageCardTraces = useMemo(
    () => extractStageCardTraces(turn.events),
    [turn.events],
  );
  // 工具执行阶段进度 (联网搜索前端展示优化): tool_call_id→阶段，旁路读原始事件（不入 ProjectedTurn），
  // 让运行中的工具（web_search）显示「正在检索/排队中/改用备用引擎」而非干等。已结束的工具自动清空。
  const toolPhases = useMemo(
    () => extractToolPhases(turn.events),
    [turn.events],
  );
  const workerToolPhases = useMemo(
    () => extractWorkerToolPhases(turn.events),
    [turn.events],
  );
  // 阻塞式求决策「待你拍板」: runId→escalation id from interactions[] (P3 · 按 id 精确提交).
  const pendingEscalations = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of p.interactions) {
      if (i.kind === "escalation" && i.status === "pending") {
        map.set(i.runId, i.id);
      }
    }
    return map;
  }, [p.interactions]);
  // 队员工具明细 (RunDetail): runId→worker 工具调用 (旁路读原始事件，不入 ProjectedTurn)，喂给
  // 团队视图的队员详情面；实时与回放同一条接线（history 走 HistoryAssistant 里的同一提取器）。
  const runToolCalls = useMemo(
    () => extractRunToolCalls(turn.events),
    [turn.events],
  );
  // 两通道：调研回合台账（fold `#rN`）vs 辩论场级台账（extract `#eN`）。
  const turnEvidenceLedger = p.evidenceLedger;
  const debateEvidenceLedger = useMemo(
    () => extractEvidenceLedger(turn.events),
    [turn.events],
  );
  const graphAppendActKinds = useMemo(
    () => extractGraphAppendActKinds(turn.events),
    [turn.events],
  );
  const graphAppendAuthorizedBy = useMemo(
    () => extractGraphAppendAuthorizedBy(turn.events),
    [turn.events],
  );
  const prevExecutionIds = useMemo(
    () => extractPrevExecutionIds(turn.events),
    [turn.events],
  );
  const meta = summarize(p);
  const clockIso = extractTurnClock(turn.events);
  const isMulti = p.runs.length > 0;
  const team = isMulti
    ? {
        agents: p.agents,
        runs: p.runs,
        progress: p.progress,
        acts: p.acts,
        teamNotes: p.teamNotes,
        status: p.status,
        conversationId,
        pendingEscalations,
        escalationsInteractive: live,
        runToolCalls,
        workerToolPhases,
        evidenceLedger: debateEvidenceLedger,
      }
    : undefined;
  const empty =
    !isMulti && p.process.length === 0 && !p.content && !p.reasoning;
  // 对齐桌面：空正文 + 结构化 error / error·unproductive → 可见失败说明。
  const finishReason = live ? null : (chrome.finishReason ?? p.finishReason);
  const stopped = finishReason === "cancelled";
  const failureNotice = resolveEmptyFailureNotice({
    content: p.content,
    finishReason,
    errorMessage: chrome.errorMessage,
    skip: live,
  });
  const errorAction = failureNotice
    ? errorActionForCode(chrome.errorCode, {
        credentialSource: chrome.credentialSource,
        message: chrome.errorMessage,
      })
    : null;
  // 回合总账 — populated by message_end (null while streaming, so it appears on finish).
  // BYOK: billed total is 0; estimated_total may carry a community-catalog estimate.
  const turnMoney =
    p.cost && p.cost.total > 0
      ? { nano: p.cost.total, estimated: false }
      : p.cost?.estimated_total && p.cost.estimated_total > 0
        ? { nano: p.cost.estimated_total, estimated: true }
        : null;
  const cost = turnMoney
    ? formatCost(turnMoney.nano, turnMoney.estimated)
    : p.cost?.pricing_source === "unpriced"
      ? COST_UNPRICED_LABEL
      : null;
  const turnWarning = p.turnWarning;
  const supportIds: SupportDiagnosticIds = {
    conversationId,
    ...extractSupportIdsFromEvents(turn.events),
    ...supportErrorExtras({
      errorCode: chrome.errorCode,
      emptyDiagnosis: chrome.emptyDiagnosis,
      bodyKind: chrome.bodyKind,
      baseUrl: chrome.baseUrl,
    }),
  };
  const finishDiagnosis = degradedFinishChipLabel(
    chrome.emptyDiagnosis,
    chrome.errorMessage,
  );
  // 空停止：聊天时间线不占「已停止」行（有团队面时 empty=false，走 TeamView）。
  if (
    empty &&
    stopped &&
    !live &&
    !failureNotice &&
    !turnWarning &&
    artifacts.length === 0
  ) {
    return null;
  }
  return (
    <>
      <div className="bubble assistant">
        {turnWarning && <div className="turn-warning">{turnWarning}</div>}
        {empty && !failureNotice ? (
          <span className="muted">{live ? "…" : ""}</span>
        ) : !empty ? (
          <AssistantContent
            process={p.process}
            content={p.content}
            reasoning={p.reasoning}
            citations={p.citations}
            evidenceLedger={turnEvidenceLedger}
            isStreaming={live}
            messageId={messageId}
            captainContext={p.captainContext}
            team={team}
            debate={p.debate}
            debateRounds={p.debateRounds}
            asks={asks}
            escalationSlots={escalationSlots}
            hotTraces={hotTraces}
            stageCardTraces={stageCardTraces}
            toolPhases={toolPhases}
            graphAppendActKinds={graphAppendActKinds}
            graphAppendAuthorizedBy={graphAppendAuthorizedBy}
            prevExecutionIds={prevExecutionIds}
            userInterjections={p.userInterjections}
            turnClosed={!live}
            onFill={onFill}
            supportIds={supportIds}
            onOpenBrowserLive={onOpenBrowserLive}
            finishReason={finishReason}
            finishDiagnosisLabel={finishDiagnosis}
            failureNotice={failureNotice}
            usage={live ? null : chrome.usage}
            rounds={live ? null : chrome.rounds}
            costText={live ? null : cost}
            durationMs={live ? null : chrome.durationMs}
            clockIso={live ? null : clockIso}
          />
        ) : null}
        {failureNotice && (
          <div className="error inline-actions">
            <span>{failureNotice}</span>
            <div className="error-card-actions">
              <SupportDiagnosticCopyButton ids={supportIds} />
              {errorAction && (
                <button
                  type="button"
                  className="retry-btn"
                  onClick={() => navigate(errorAction.href)}
                >
                  {errorAction.label}
                </button>
              )}
              {onRetry && (
                <button type="button" className="retry-btn" onClick={onRetry}>
                  重试
                </button>
              )}
            </div>
          </div>
        )}
        <FileArtifactsCard
          artifacts={artifacts}
          reviewArtifacts={reviewArtifacts}
          conversationId={conversationId}
          messageId={messageId}
        />
        {/* The team view carries its own progress header; the one-line meta is the
            single-agent fallback. */}
        {!isMulti && meta && <div className="meta">{meta}</div>}
      </div>
    </>
  );
}

// A persisted assistant message, replayed through the SAME fold/rendering as a live turn:
// a multi-agent turn re-folds its run/tool journal (runs.events) into the team view, a
// single-agent tool turn restores its process timeline (runs.process), and the captain's
// reply / 思考 / 引用 come off the authoritative top-level fields. A row with nothing to
// show (a bare tool-only turn) renders nothing.
function HistoryAssistant({
  m,
  conversationId,
  onFill,
  onRetry,
  isLast,
}: {
  m: MessageDetail;
  conversationId: string | null;
  onFill: (text: string) => void;
  onRetry?: () => void;
  isLast?: boolean;
}) {
  const navigate = useNavigate();
  const {
    team,
    debate,
    debateRounds,
    turnWarning,
    foldEvidenceLedger,
    graphAppendActKinds,
    graphAppendAuthorizedBy,
    prevExecutionIds,
    deliveryStatus,
    userInterjections,
    foldedProcess,
    chrome,
  } = useMemo(() => {
    const events = m.runs?.events;
    const warning =
      m.runs?.turn_warning ??
      (events?.length ? extractTurnWarning(events) : null);
    const emptyChrome = {
      usage: null as UsageBreakdown | null,
      rounds: null as number | null,
      durationMs: null as number | null,
      finishReason: null as string | null,
      emptyDiagnosis: undefined as string | undefined,
      bodyKind: undefined as string | undefined,
      baseUrl: undefined as string | undefined,
      errorCode: undefined as string | undefined,
      errorMessage: undefined as string | undefined,
      credentialSource: undefined as string | null | undefined,
    };
    if (!events || events.length === 0)
      return {
        team: undefined,
        debate: null,
        debateRounds: [] as DebateNarrativeRound[],
        turnWarning: warning,
        foldEvidenceLedger: [],
        graphAppendActKinds: new Map<string, string>(),
        graphAppendAuthorizedBy: new Map<string, string>(),
        prevExecutionIds: new Map<string, string>(),
        deliveryStatus: null,
        userInterjections: [] as ProjectedTurn["userInterjections"],
        foldedProcess: [] as ProjectedTurn["process"],
        chrome: emptyChrome,
      };
    const p = fold(events);
    const team =
      p.runs.length > 0
        ? {
            agents: p.agents,
            runs: p.runs,
            progress: p.progress,
            acts: p.acts,
            teamNotes: p.teamNotes,
            status: p.status,
            runToolCalls: extractRunToolCalls(events),
            // 辩论场级 `#eN`（勿写入 Message.evidence_ledger 语义）
            evidenceLedger: extractEvidenceLedger(events),
          }
        : undefined;
    return {
      team,
      debate: p.debate,
      debateRounds: p.debateRounds,
      turnWarning: warning ?? p.turnWarning,
      foldEvidenceLedger: p.evidenceLedger,
      graphAppendActKinds: extractGraphAppendActKinds(events),
      graphAppendAuthorizedBy: extractGraphAppendAuthorizedBy(events),
      prevExecutionIds: extractPrevExecutionIds(events),
      deliveryStatus: p.deliveryStatus,
      userInterjections: p.userInterjections,
      foldedProcess: p.process,
      chrome: extractTurnChrome(events),
    };
  }, [m.runs]);
  // REST process 权威；旧 journal 未落 user_interjection marker 时用 fold 回放补位。
  const restProcess = m.runs?.process ?? undefined;
  const process = (() => {
    const restHasInj = restProcess?.some((s) => s.kind === "user_interjection");
    const foldHasInj = foldedProcess.some(
      (s) => s.kind === "user_interjection",
    );
    if (foldHasInj && !restHasInj) return foldedProcess;
    return restProcess;
  })();
  // 历史冷启动优先 REST `evidence_ledger`；缺列时回退 journal fold 的回合台账。
  const historyEvidenceLedger = m.evidenceLedger?.length
    ? m.evidenceLedger
    : foldEvidenceLedger;
  // 历史无 events → deliveryStatus 恒 null；有 process 工具产物时旁路出卡 + A1 预览。
  const { list: artifacts, review: reviewArtifacts } = useMemo(
    () =>
      resolveArtifactsForTurn({
        deliveryStatus,
        process,
        events: m.runs?.events,
      }),
    [deliveryStatus, process, m.runs?.events],
  );
  // 非阻塞提问卡内容：仅多 Agent 历史持久化 runs.events（单聊为空 → 无卡，与桌面一致）。
  const asks = useMemo(() => extractAsks(m.runs?.events ?? []), [m.runs]);
  const escalationSlots = useMemo(
    () => extractEscalationSlots(m.runs?.events ?? []),
    [m.runs],
  );
  // 热审批/委派授权痕迹 (D3): 单聊审批回合的 events 也过 journal surface（二期），故历史可取。
  const hotTraces = useMemo(
    () => extractHotDecisionTraces(m.runs?.events ?? []),
    [m.runs],
  );
  const stageCardTraces = useMemo(
    () => extractStageCardTraces(m.runs?.events ?? []),
    [m.runs],
  );
  // P2：优先用 messages.cost 列（平台记账）；缺列或 BYOK 记账为 0 时 lazy-fetch 台账（含 estimated_cost）。
  const columnBilled =
    m.cost && m.cost.total > 0
      ? { nano: m.cost.total, estimated: false as const }
      : null;
  const { ref, money: lazyMoney } = useLazyMessageCost(
    columnBilled == null ? m.id : "",
  );
  const money = columnBilled ?? lazyMoney;
  const cost =
    money && money.nano > 0
      ? formatCost(money.nano, money.estimated)
      : m.cost?.pricing_source === "unpriced" || lazyMoney?.unpriced
        ? COST_UNPRICED_LABEL
        : null;
  const streaming = m.status === "running" && !m.paused;
  const finishReason = m.runs?.finish_reason ?? chrome.finishReason ?? null;
  // Cold path: prefer live chrome (SSE error in events), else durable runs.error.
  const errorMessage =
    chrome.errorMessage ?? m.runs?.error?.message ?? undefined;
  const errorCode = chrome.errorCode ?? m.runs?.error?.code ?? undefined;
  const interrupted =
    m.status === "incomplete" || finishReason === "interrupted";
  const emptyBody =
    !team &&
    (!process || process.length === 0) &&
    !m.content &&
    !m.reasoning_content &&
    m.citations.length === 0 &&
    artifacts.length === 0;
  const failureNotice = resolveEmptyFailureNotice({
    content: m.content,
    finishReason,
    errorMessage,
    skip: streaming,
  });
  const errorAction = failureNotice
    ? errorActionForCode(errorCode, {
        credentialSource: chrome.credentialSource,
        message: errorMessage,
      })
    : null;
  const supportIds = historySupportIds(
    m,
    conversationId,
    supportErrorExtras({
      errorCode,
      emptyDiagnosis: chrome.emptyDiagnosis,
      bodyKind: chrome.bodyKind,
      baseUrl: chrome.baseUrl,
    }),
  );
  // Stopped empty = omit chat-timeline face (P1); interrupted may keep recover.
  const showRetry = !!onRetry && isLast && (interrupted || !!failureNotice);
  const finishDiagnosis = degradedFinishChipLabel(
    chrome.emptyDiagnosis,
    errorMessage,
  );

  if (
    emptyBody &&
    !turnWarning &&
    !interrupted &&
    !streaming &&
    !failureNotice &&
    userInterjections.length === 0
  ) {
    return null;
  }
  return (
    <>
      <div
        className="bubble assistant"
        ref={columnBilled == null ? ref : undefined}
      >
        {turnWarning && <div className="turn-warning">{turnWarning}</div>}
        {streaming && !m.content && !m.reasoning_content && !process?.length ? (
          <span className="muted">…</span>
        ) : emptyBody && failureNotice ? null : (
          <AssistantContent
            process={process}
            content={m.content ?? ""}
            reasoning={m.reasoning_content ?? undefined}
            citations={m.citations}
            evidenceLedger={historyEvidenceLedger}
            isStreaming={streaming}
            messageId={m.id}
            captainContext={m.runs?.captain_context ?? undefined}
            team={team}
            debate={debate}
            debateRounds={debateRounds}
            asks={asks}
            escalationSlots={escalationSlots}
            hotTraces={hotTraces}
            stageCardTraces={stageCardTraces}
            graphAppendActKinds={graphAppendActKinds}
            graphAppendAuthorizedBy={graphAppendAuthorizedBy}
            prevExecutionIds={prevExecutionIds}
            userInterjections={userInterjections}
            turnClosed
            onFill={onFill}
            supportIds={supportIds}
            finishReason={streaming ? null : finishReason}
            finishDiagnosisLabel={finishDiagnosis}
            failureNotice={failureNotice}
            usage={streaming ? null : (m.usage ?? chrome.usage)}
            rounds={streaming ? null : (m.rounds ?? chrome.rounds)}
            costText={streaming ? null : cost}
            durationMs={streaming ? null : (m.duration_ms ?? chrome.durationMs)}
            clockIso={streaming ? null : m.created_at}
          />
        )}
        {failureNotice && (
          <div className="error inline-actions">
            <span>{failureNotice}</span>
            <div className="error-card-actions">
              <SupportDiagnosticCopyButton ids={supportIds} />
              {errorAction && (
                <button
                  type="button"
                  className="retry-btn"
                  onClick={() => navigate(errorAction.href)}
                >
                  {errorAction.label}
                </button>
              )}
              {showRetry && (
                <button type="button" className="retry-btn" onClick={onRetry}>
                  重试
                </button>
              )}
            </div>
          </div>
        )}
        <FileArtifactsCard
          artifacts={artifacts}
          reviewArtifacts={reviewArtifacts}
          conversationId={conversationId}
          messageId={m.id}
        />
        {interrupted && showRetry && !failureNotice && (
          <button type="button" className="retry-btn" onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    </>
  );
}

export function ChatPage() {
  const navigate = useNavigate();
  const { id: conversationId } = useParams<{ id: string }>();
  // 历史对话抽屉 (☰): the chat is the landing surface now; history slides in over it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [history, setHistory] = useState<MessageDetail[] | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  /** 诚实停止过渡：stopping 时 UI 不先于后端进终态；与 sending 合成 busy。 */
  const [stopPhase, setStopPhase] = useState<StopUiPhase>("idle");
  const [error, setError] = useState<ChatError | null>(null);
  /** 对账发现本地幽灵项（服务端重启丢队）时的一次轻提示。 */
  const [queueDroppedHint, setQueueDroppedHint] = useState<string | null>(null);
  /** 本会话权限四轴（草稿本地；已有会话跟 conversation.permission_axes）。 */
  const [permissionAxes, setPermissionAxes] = useState<PermissionAxes>(
    DEFAULT_PERMISSION_AXES,
  );
  const [permissionDraftTouched, setPermissionDraftTouched] = useState(false);
  // 会话级模型组合 (定案 B · 拍快照): snapshotted profile id (null = draft / not yet chosen).
  // A draft seeds from last-used profile；「＋」菜单打开 ModelPicker（只选具体组合）。
  const [currentProfileId, setCurrentProfileId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [permissionSheetOpen, setPermissionSheetOpen] = useState(false);
  const { data: modelProfiles } = useModelProfiles();
  // Files staged for the next send (composer 附件): text inline and/or binary resident.
  // Oversized / upload failures surface `attachError` and aren't staged.
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  // The composer textarea — focused after ask / debate handoff fill so the user can edit/send.
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  // Turns that paused at a checkpoint then lost their stream (durable resume frames),
  // recovery shell on reopen (结构化挂起 2b). Live paint authority = cold Interaction store.
  const [paused, setPaused] = useState<PausedTurnSummary[]>([]);
  const coldById = useColdInteractions();
  /** CEO host server message_id for the active live turn (message_start stamp). */
  const hostServerMessageIdRef = useRef<string | null>(null);
  /** Sandbox browser live sheet (Step4 · C): login card / hot escalate open this. */
  const [browserLiveOpen, setBrowserLiveOpen] = useState(false);
  const [browserLiveSessionId, setBrowserLiveSessionId] = useState<
    string | null
  >(null);
  const openBrowserLive = useCallback(
    (opts?: OpenBrowserLiveOpts) => {
      if (!conversationId) {
        setBrowserLiveOpen(true);
        return;
      }
      void listBrowserSessions(conversationId)
        .then((list) => {
          let sid = "";
          const wantRun = opts?.runId?.trim();
          if (wantRun) {
            const match = list.sessions.find(
              (s) => s.runId?.trim() === wantRun,
            );
            if (match?.sessionId?.trim()) sid = match.sessionId.trim();
          }
          if (!sid) {
            sid =
              list.activeSessionId?.trim() ||
              list.sessions[0]?.sessionId?.trim() ||
              "";
          }
          setBrowserLiveSessionId(sid || null);
        })
        .catch(() => {
          setBrowserLiveSessionId(null);
        })
        .finally(() => {
          setBrowserLiveOpen(true);
        });
    },
    [conversationId],
  );
  const [recoveredInteractions, setRecoveredInteractions] = useState<
    PendingInteractionSummary[]
  >([]);
  // Older messages exist above the loaded window (drives 加载更早); `loadingOlder` blocks
  // re-entrancy while a page is in flight (历史上翻分页).
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // 「记忆已更新」卡 (③ §1.6): the latest window's offline-consolidation results, pinned at the
  // thread tail. Only the newest window carries them, so scroll-up (loadOlder) leaves them be.
  const [memoryUpdates, setMemoryUpdates] = useState<MemoryUpdate[]>([]);
  // Offline consolidation post-dates the turn — bump this gen to cancel in-flight polls on
  // conversation switch / unmount (mobile has no memory_updated firehose).
  const memoryPollGenRef = useRef(0);
  // REL-002: execution_completed → short-delay getMessages retries for harvest 终稿.
  // Cancel on conversation switch (leave/reopen still loads via the effect below).
  const harvestRefreshRef = useRef(
    createHarvestRefreshScheduler(async (cid, isCurrent) => {
      const {
        messages,
        hasMoreBefore: more,
        memoryUpdates: mem,
      } = await getMessages(cid);
      if (!isCurrent()) return;
      setHistory(messages);
      setHasMoreBefore(more);
      setMemoryUpdates(mem);
      setTurns((t) => dropSettledLiveTurns(t));
    }),
  );
  // The controller for the stream currently held open (send / reattach). Conversation
  // switch aborts it; 用户停止 does NOT — keep SSE until backend message_end (诚实过渡).
  const abortRef = useRef<AbortController | null>(null);
  /** Mid-flight AC 集合（切会话一并 abort；Stop 不清队、不 abort 排队连接）。 */
  const midFlightControllersRef = useRef(new Set<AbortController>());
  /** queue_id → mid-flight AC（取消成功后再 abort，避免失败留下断连坏态）。 */
  const midFlightByQueueRef = useRef(new Map<string, AbortController>());
  /**
   * 排队条对账（GET 权威）。ref 避免 appendEventToTurn / reconnect 闭包陈旧。
   * 本地有项而服务端已无 → 一次轻提示再清。
   */
  const reconcileQueuedRef = useRef<(cid: string) => void>(() => {});
  reconcileQueuedRef.current = (cid: string) => {
    void reconcileQueuedTurns(cid).then((result) => {
      if (result.failed) return;
      if (result.droppedLocalIds.length > 0) {
        setQueueDroppedHint(QUEUE_DROPPED_HINT);
      }
    });
  };
  /** 当前主路 / 续流写入目标 turn id（排队期条外仍指向主路，勿写到队尾）。 */
  const activeTurnIdRef = useRef<string | null>(null);
  const [activeStreamTurnId, setActiveStreamTurnId] = useState<string | null>(
    null,
  );
  const setActiveTurn = (id: string | null) => {
    if (id !== activeTurnIdRef.current) {
      hostServerMessageIdRef.current = null;
    }
    activeTurnIdRef.current = id;
    setActiveStreamTurnId(id);
  };
  /** 主路 SSE 是否仍在泵（供 mid-flight 等 drain 边界）。 */
  const primaryActiveRef = useRef(false);
  const primaryIdleWaitersRef = useRef<Array<() => void>>([]);
  /** 主路 + mid-flight 在途数；>0 则 sending。 */
  const inflightRef = useRef(0);
  const stopPhaseRef = useRef<StopUiPhase>("idle");

  const markStreamStart = () => {
    inflightRef.current += 1;
    setSending(true);
  };

  const markStreamEnd = () => {
    inflightRef.current = Math.max(0, inflightRef.current - 1);
    if (inflightRef.current === 0) setSending(false);
  };

  const signalPrimaryIdle = () => {
    primaryActiveRef.current = false;
    const waiters = primaryIdleWaitersRef.current.splice(0);
    for (const w of waiters) w();
  };

  const waitPrimaryIdle = () => {
    if (!primaryActiveRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      primaryIdleWaitersRef.current.push(resolve);
    });
  };

  const applyStopPhase = (phase: StopUiPhase) => {
    stopPhaseRef.current = phase;
    setStopPhase(phase);
  };

  /** Fresh read — avoids TS narrowing `stopPhaseRef.current` across awaits. */
  const isStoppingNow = (): boolean => stopPhaseRef.current === "stopping";

  const clearStopping = () => {
    applyStopPhase("idle");
  };

  const busy = isStopBusy(sending, stopPhase);

  // Stick-to-bottom with upward-gesture detach + hysteresis (流式时上滑不强制贴底).
  // contentKey grows with the live tail so streaming tokens re-pin only while stuck.
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const lastHist =
    history && history.length > 0 ? history[history.length - 1] : null;
  const scrollContentKey = `${history?.length ?? 0}-${turns.length}-${lastTurn?.id ?? ""}-${lastTurn?.events.length ?? 0}-${lastHist?.id ?? ""}-${lastHist?.content?.length ?? 0}`;
  const { scrollRef, atBottom, jumpToBottom, preparePrepend, cancelPrepend } =
    useStickScroll(scrollContentKey, conversationId ?? null);

  // 语音输入 (桌面对齐)：转写文本追加到现有草稿 (不覆盖)，完成后聚焦输入框供编辑再发。
  // web 浏览器走 Web Speech API、原生壳走 capgo 插件，两者都不可用则 isSupported=false (按钮隐藏)。
  const voice = useVoiceInput({
    onTranscript: useCallback((text: string) => {
      setInput((prev) => (prev.trim() ? `${prev} ${text}` : text));
      requestAnimationFrame(() => composerInputRef.current?.focus());
    }, []),
  });

  // Append an event to a specific turn (主路 / mid-flight 续流各写各的；勿依赖「最后一项」).
  // Lazily opens a userText-less turn when none exists yet (reattach on reopen).
  const appendEventToTurn = (turnId: string | null, event: SSEEvent) => {
    // 诚实停止：stopping 丢弃正文/工具突变，仍消费 run_* + 终态确认。
    if (
      stopPhaseRef.current === "stopping" &&
      !allowsEventWhileStopping(event.type)
    ) {
      return;
    }
    // EPHEMERAL：冷 resume × live deferred — 同连接等待槽空，不是 409。
    if (event.type === "resume_deferred") {
      const p = event.payload as ResumeDeferredPayload;
      if (
        p.message_id &&
        (p.busy_reason === "wrap_up" || p.busy_reason === "live_turn")
      ) {
        markColdDeferred({
          messageId: p.message_id,
          conversationId: p.conversation_id || conversationId || undefined,
          busyReason: p.busy_reason,
        });
      }
      return;
    }
    // EPHEMERAL：按项取消 → 只清条 + abort mid-flight（排队期无主时间线用户泡）。
    if (event.type === "turn_queue_cancelled" && conversationId) {
      const p = event.payload as TurnQueueCancelledPayload;
      removeQueuedTurn(conversationId, p.queue_id);
      const ac = midFlightByQueueRef.current.get(p.queue_id);
      if (ac) {
        ac.abort();
        midFlightByQueueRef.current.delete(p.queue_id);
        midFlightControllersRef.current.delete(ac);
      }
      return;
    }
    // EPHEMERAL：出队开跑（sink 首帧，先于 message_start）→ 清条；用户泡由 beginTurn2 插入。
    // 否决靠 message_start 猜出队。
    if (event.type === "turn_queue_started" && conversationId) {
      const p = event.payload as TurnQueueStartedPayload;
      removeQueuedTurn(conversationId, p.queue_id);
      // 已开跑：不再可按项取消；勿 abort（同连接续流 turn2）。
      midFlightByQueueRef.current.delete(p.queue_id);
      return;
    }
    // turn_queued：发送路径已由 onQueued 本地即时写入；此处仅当信号缺本地项时对账
    // （协调升格进队 / 多端同步等）。不写入主路 events。
    if (event.type === "turn_queued") {
      if (conversationId) {
        const p = event.payload as TurnQueuedPayload;
        const queueId = typeof p.queue_id === "string" ? p.queue_id : "";
        if (
          queueId &&
          !listQueuedTurns(conversationId).some((e) => e.queueId === queueId)
        ) {
          reconcileQueuedRef.current(conversationId);
        }
      }
      return;
    }
    let createdId: string | null = null;
    setTurns((t) => {
      if (t.length === 0) {
        const id = turnId ?? crypto.randomUUID();
        createdId = id;
        return [{ id, userText: null, events: [event] }];
      }
      const targetId = turnId ?? activeTurnIdRef.current ?? t[t.length - 1].id;
      const idx = t.findIndex((x) => x.id === targetId);
      if (idx < 0) {
        // 目标不存在（已取消）——丢弃，勿污染其它 turn。
        return t;
      }
      const next = t.slice();
      const cur = next[idx];
      next[idx] = { ...cur, events: [...cur.events, event] };
      return next;
    });
    if (createdId && !activeTurnIdRef.current) setActiveTurn(createdId);
    if (stopPhaseRef.current === "stopping" && isStopConfirmEvent(event.type)) {
      clearStopping();
    }
    // Live cold ResumeCard authority (检查点与开工卡 · Live 出卡):
    // `*_required` → cold IX; message_start stamp → rekey/bind → paint. Do not wait for
    // message_end → getRecovery as the only path (desktop parity; mobile-local store).
    if (conversationId) {
      if (event.type === "message_start") {
        const serverId = (event.payload as MessageStartPayload).message_id;
        const clientId = turnId ?? activeTurnIdRef.current ?? createdId ?? null;
        if (serverId) {
          hostServerMessageIdRef.current = serverId;
          if (clientId) rekeyColdMessageId(clientId, serverId);
          bindEmptyColdMessageId(conversationId, serverId);
          // Deferred wait ends when claim+续跑 stamps message_start on this host.
          for (const e of listColdPending(conversationId)) {
            if (e.messageId !== serverId) continue;
            if (e.status !== "submitting") continue;
            markColdResolved({
              kind: e.kind,
              id: e.id,
              resolution: e.resolution,
            });
          }
        }
      }
      const isColdWire =
        kindFromColdRequiredEvent(event.type) != null ||
        kindFromColdResolvedEvent(event.type) != null ||
        event.type === "interaction_orphaned";
      if (isColdWire) {
        // Cold bind: never nail pending to an unsealed client bubble when a
        // same-turn stamp / resume key exists (ask continue → team_preview).
        const preferred =
          hostServerMessageIdRef.current ??
          turnId ??
          activeTurnIdRef.current ??
          createdId ??
          "";
        const bindHosts: ColdResumeHost[] = [];
        for (const m of history ?? []) {
          if (m.role === "assistant") {
            bindHosts.push({
              role: "assistant",
              id: m.id,
              serverMessageId: m.id,
            });
          }
        }
        const targetTurnId =
          turnId ?? activeTurnIdRef.current ?? createdId ?? null;
        for (const t of turns) {
          const events =
            targetTurnId && t.id === targetTurnId
              ? [...t.events, event]
              : t.events;
          bindHosts.push({
            role: "assistant",
            id: t.id,
            serverMessageId: extractMessageId(events),
          });
        }
        if (createdId && !turns.some((t) => t.id === createdId)) {
          bindHosts.push({
            role: "assistant",
            id: createdId,
            serverMessageId: extractMessageId([event]),
          });
        }
        const hostId = resolveColdBindHostId(bindHosts, preferred, {
          resumeStamp: hostServerMessageIdRef.current,
        });
        applyColdInteractionWireEvent(
          event.type,
          (event.payload ?? {}) as Record<string, unknown>,
          conversationId,
          hostId,
        );
      }
    }
    // 挂起即收口 (②): a live stream can END at a durable checkpoint — message_end carries
    // finish_reason=paused. The turn finalized (its in-process resolve Future was never
    // parked), so the live PauseCard no longer applies; re-read the recovery snapshot so
    // its durable ResumeCard surfaces once the stream settles (the single cold resume
    // path), exactly as a reopen would. One chokepoint for every stream
    // (send/resume/reconnect/attach), mirroring the desktop's message_end handler.
    if (conversationId && event.type === "message_end") {
      if ((event.payload as MessageEndPayload).finish_reason === "paused") {
        void refreshPaused(conversationId);
      }
      // 记忆更新可发现性: consolidation is offline/async — schedule delayed refreshes of
      // the thread-tail card so the user does not have to leave and reopen the chat.
      scheduleMemoryPoll(conversationId);
    }
    // REL-002: 后台执行终态 — fold no-op；经 getMessages 拉入 harvest 终稿（短延迟重试）。
    if (conversationId && event.type === "execution_completed") {
      harvestRefreshRef.current.schedule(conversationId);
    }
  };

  const appendEvent = (event: SSEEvent) =>
    appendEventToTurn(activeTurnIdRef.current, event);

  // Pull the latest window's memory_updates into the thread-tail card. Best-effort; a
  // failure must never disrupt the settled turn.
  async function refreshMemoryUpdates(cid: string) {
    try {
      const { memoryUpdates: next } = await getMessages(cid);
      setMemoryUpdates(next);
    } catch {
      /* ignore — poll is best-effort */
    }
  }

  // Delayed poll after message_end (2s / 8s / 20s). Always runs the full schedule so a
  // pre-existing card from an earlier turn does not abort before a fresh pass lands;
  // cancelled when the conversation changes (gen bump).
  function scheduleMemoryPoll(cid: string) {
    const gen = ++memoryPollGenRef.current;
    const delays = [2000, 8000, 20000];
    void (async () => {
      for (const ms of delays) {
        await new Promise((r) => setTimeout(r, ms));
        if (memoryPollGenRef.current !== gen) return;
        await refreshMemoryUpdates(cid);
        if (memoryPollGenRef.current !== gen) return;
      }
    })();
  }

  // Load the persisted transcript for the conversation in the URL — this is what makes a
  // refresh keep the conversation (刷新不丢): the id rides the route, the history is the
  // server's. Turns sent this session stream live below it (via the fold). If the latest
  // turn has no persisted reply (ends at a user message), a run may still be live
  // (执行与请求解耦 C1 · slice 1b): rejoin it and 续看 it finish.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect 按会话(conversationId/navigate)生命周期挂载重连 run；clearStopping 等仅作副作用调用，列入依赖会破坏重挂载语义
  useEffect(() => {
    // Cancel any in-flight memory-update polls / harvest refreshes from the previous conversation.
    memoryPollGenRef.current += 1;
    harvestRefreshRef.current.cancel();
    if (!conversationId) {
      // Draft (直接对话): no server conversation yet — ready to type, nothing to load.
      setHistory([]);
      setTurns([]);
      setError(null);
      setQueueDroppedHint(null);
      setSending(false);
      clearStopping();
      setPaused([]);
      clearColdInteractions();
      hostServerMessageIdRef.current = null;
      setHasMoreBefore(false);
      setMemoryUpdates([]);
      setPermissionDraftTouched(false);
      setMoreOpen(false);
      setPermissionSheetOpen(false);
      // 新对话继承上次选择: seed the draft's profile from last-used (localStorage);
      // passed as POST model_profile_id on first send (startDraft · 定案 B).
      setCurrentProfileId(getLastModelProfileId());
      setActiveTurn(null);
      // Seed draft axes from account default recipe (best-effort).
      void getAutonomy()
        .then((d) => {
          setPermissionAxes(recipeToAxes(d.policy));
        })
        .catch(() => {
          setPermissionAxes(DEFAULT_PERMISSION_AXES);
        });
      return;
    }
    setHistory(null);
    setTurns([]);
    setError(null);
    setQueueDroppedHint(null);
    setSending(false);
    setPaused([]);
    clearColdInteractions();
    hostServerMessageIdRef.current = null;
    setRecoveredInteractions([]);
    setBrowserLiveOpen(false);
    setBrowserLiveSessionId(null);
    setHasMoreBefore(false);
    setMemoryUpdates([]);
    setPermissionAxes(DEFAULT_PERMISSION_AXES);
    setPermissionDraftTouched(false);
    setMoreOpen(false);
    setPermissionSheetOpen(false);
    setCurrentProfileId(null);
    setActiveTurn(null);
    let cancelled = false;
    void getConversation(conversationId)
      .then((c) => {
        if (cancelled) return;
        setPermissionAxes(normalizeAxes(c.permission_axes));
        setCurrentProfileId(c.model_profile_id ?? null);
      })
      .catch(() => {
        /* best-effort */
      });
    // 统一恢复态快照（recovery 统一, 对称 §18.2）：一次属主校验读，既给出「待恢复」卡要用的挂起帧
    // （结构化挂起 2b），又给出「是否还有 detached live run 可续看」(slice 1b)。尽力而为，永不阻塞
    // 打开会话（失败 = 空快照，回合下次重开仍可恢复）。保留为 promise，让下方 attach 决策对齐同一
    // 份快照（与桌面端一致）。
    const recoveryLoaded = getRecovery(conversationId).catch(
      (): TurnRecovery => ({
        liveRunning: false,
        paused: [],
        pendingInteractions: [],
      }),
    );
    // 排队条对账：开会话 / 切会话拉 GET 权威快照（禁轮询；EPHEMERAL 仅信号）。
    reconcileQueuedRef.current(conversationId);
    void recoveryLoaded.then((r) => {
      if (!cancelled) {
        setPaused(r.paused);
        setRecoveredInteractions(r.pendingInteractions);
        // Hydrate cold IX from recovery paused frames (reopen shell → live authority).
        for (const p of r.paused) {
          if (!isColdResumeKind(p.kind)) continue;
          upsertColdRequired({
            kind: p.kind,
            conversationId,
            messageId: p.message_id,
            payload: pausedSummaryToRequiredPayload(p),
            status: "pending",
          });
        }
      }
    });
    getMessages(conversationId)
      .then(async ({ messages, hasMoreBefore: more, memoryUpdates }) => {
        if (cancelled) return;
        setHistory(messages);
        setHasMoreBefore(more);
        // 「记忆已更新」卡 (③ §1.6): only the latest window carries them — pin at the thread
        // tail. A (re)open/refresh loads them; after message_end we also poll (no firehose),
        // and scroll-up (loadOlder) never overwrites them.
        setMemoryUpdates(memoryUpdates);
        // A draft's first message, handed off across the / → /c/:id remount: POST + stream
        // it now (the conversation exists but has no run yet, so attach would no-op).
        if (pendingFirstSend && pendingFirstSend.id === conversationId) {
          const p = pendingFirstSend;
          pendingFirstSend = null;
          void send({ text: p.text, attachments: p.attachments });
          return;
        }
        const last = messages[messages.length - 1];
        if (last && last.role === "user") {
          // 单一快照决定唯一可操作面：仅当有 detached live run 且无挂起帧时才 attach 续看。挂起即
          // 收口 (②)：到达 checkpoint 的回合已 FINALIZE（run 结束、落帧），是纯 durable——「待恢复」
          // 卡为唯一面，不再 attach（唯一的 live∩durable 重叠是 §六-1 薄网，帧没存住、paused 本就为
          // 空，进不到这支）。liveRunning 与 attach 端点同源活性判据 → 一次读即定面，liveRunning/
          // paused 不会互相矛盾（源头消除竞态，而非排序绕过）。
          const recovery = await recoveryLoaded;
          if (cancelled) return;
          if (recovery.liveRunning && recovery.paused.length === 0) {
            void attachOnOpen(conversationId);
          }
        } else if (
          last &&
          last.role === "assistant" &&
          last.status === "running"
        ) {
          // P4: overlay partial already painted; live → clear-then-fold rejoin;
          // dead lease ghost → interrupted affordance (no forever spinner).
          const recovery = await recoveryLoaded;
          if (cancelled) return;
          if (recovery.liveRunning && recovery.paused.length === 0) {
            void rejoinRunningHistory(conversationId);
          } else if (!recovery.liveRunning && recovery.paused.length === 0) {
            setHistory((h) => {
              if (!h || h.length === 0) return h;
              const next = h.slice();
              const i = next.length - 1;
              next[i] = {
                ...next[i],
                status: "incomplete",
                runs: {
                  events: next[i].runs?.events ?? [],
                  finish_reason: "interrupted",
                  process: next[i].runs?.process ?? null,
                  captain_context: next[i].runs?.captain_context,
                  turn_warning: next[i].runs?.turn_warning,
                },
              };
              return next;
            });
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (!getTokens()) {
          navigate("/login", { replace: true });
          return;
        }
        setError({ text: e instanceof Error ? e.message : "加载消息失败" });
        setHistory([]);
      });
    // Switching conversation aborts any held stream so its events can't pollute the next
    // conversation's turns (shared state — turns aren't keyed by conversation). The server
    // run keeps going detached (slice 1a); reopening reattaches.
    return () => {
      cancelled = true;
      harvestRefreshRef.current.cancel();
      abortRef.current?.abort();
      for (const ac of midFlightControllersRef.current) ac.abort();
      midFlightControllersRef.current.clear();
      midFlightByQueueRef.current.clear();
      clearStopping();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, navigate]);

  // Page strictly older messages in above the window (历史上翻分页). The oldest loaded
  // row's created_at is the cursor; we anchor the viewport (distance-from-bottom) so the
  // prepend doesn't yank the scroll. Re-entrancy-guarded; the chat keeps working if it fails.
  async function loadOlder() {
    if (!conversationId || loadingOlder || !hasMoreBefore) return;
    const oldest = history?.[0];
    if (!oldest) return;
    preparePrepend();
    setLoadingOlder(true);
    try {
      const { messages, hasMoreBefore: more } = await getMessages(
        conversationId,
        oldest.created_at,
      );
      setHistory((h) => [...messages, ...(h ?? [])]);
      setHasMoreBefore(more);
    } catch (e) {
      cancelPrepend();
      setError({
        text: e instanceof Error ? e.message : "加载更早消息失败",
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  // The live turn's projection drives the interactive pause surface: while a stream is
  // held open (`busy`) and the fold reports a gate, the PauseCard below offers
  // resolution — equally for a fresh turn and one rejoined via reattach (a run paused at
  // an approval shows its live card on reconnect).
  // 出队开跑后「最后一项」可能是新 turn——投影须跟 activeTurnId。
  const liveTurn =
    turns.find((t) => t.id === activeStreamTurnId) ??
    (turns.length > 0 ? turns[turns.length - 1] : null);
  const liveProjection = useMemo(
    () => (liveTurn ? fold(liveTurn.events) : null),
    [liveTurn],
  );
  const interruptible = isLiveInterruptible(liveProjection);
  // busy 默认 queue（defaultDelivery）；插队轻链显式 steer；interruptible 仅作文案启发式。
  // 挂起即收口 (②, Phase 3): hot-path cards resolve live in-stream; cold path
  // (ask_user / plan_review / team_preview) finalizes and uses ResumeCard.
  const liveInteractions = busy
    ? (liveProjection?.interactions ?? []).filter((i) => i.status === "pending")
    : [];
  const liveApprovals = liveInteractions.filter(
    (i): i is Extract<ProjectedInteraction, { kind: "approval" }> =>
      i.kind === "approval",
  );
  const liveDelegations = liveInteractions.filter(
    (
      i,
    ): i is Extract<
      ProjectedInteraction,
      { kind: "delegation_authorization" }
    > => i.kind === "delegation_authorization",
  );
  const approvalCards =
    liveApprovals.length > 0
      ? liveApprovals
      : recoveredInteractions
          .map(recoveredApprovalPending)
          .filter((x): x is NonNullable<typeof x> => x != null);
  const delegationCards =
    liveDelegations.length > 0
      ? liveDelegations
      : recoveredInteractions
          .map(recoveredDelegation)
          .filter((x): x is NonNullable<typeof x> => x != null);

  // 阶段推进卡（批 B）：幕 1 收尾后耐久展示；live fold 优先，冷开走 recovery。
  const stageCards = useMemo(() => {
    const fromLive = (liveProjection?.interactions ?? []).filter(
      (i): i is Extract<ProjectedInteraction, { kind: "stage_card" }> =>
        i.kind === "stage_card" &&
        (i.status === "pending" || i.status === "orphaned"),
    );
    if (fromLive.length > 0) return fromLive;
    if (busy) return [];
    return recoveredInteractions
      .map(recoveredStageCard)
      .filter((x): x is NonNullable<typeof x> => x != null);
  }, [liveProjection, recoveredInteractions, busy]);

  // 冷恢复 escalation：composer 上方可答卡（优先于 HistoryAssistant 时间线 interactive）。
  const escalationCards = useMemo(() => {
    if (busy) return [];
    return recoveredInteractions
      .map(recoveredEscalation)
      .filter((x): x is NonNullable<typeof x> => x != null);
  }, [recoveredInteractions, busy]);

  // Live cold ResumeCard: Interaction pending (+ stamp) is authority; recovery paused = shell.
  const coldHosts = useMemo((): ColdResumeHost[] => {
    const hosts: ColdResumeHost[] = [];
    for (const m of history ?? []) {
      if (m.role === "assistant") {
        hosts.push({
          role: "assistant",
          id: m.id,
          serverMessageId: m.id,
        });
      }
    }
    for (const t of turns) {
      hosts.push({
        role: "assistant",
        id: t.id,
        serverMessageId: extractMessageId(t.events),
      });
    }
    return hosts;
  }, [history, turns]);

  const visibleResumes = useMemo(() => {
    if (!conversationId) return [];
    let userMessage = "";
    let userMessageId = "";
    for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
      const m = history?.[i];
      if (m?.role === "user") {
        userMessage = m.content ?? "";
        userMessageId = m.id;
        break;
      }
    }
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t?.userText) {
        userMessage = t.userText;
        break;
      }
    }
    return selectVisibleColdResumes({
      conversationId,
      byId: coldById,
      paused,
      hosts: coldHosts,
      userMessage,
      userMessageId,
    });
  }, [conversationId, coldById, paused, coldHosts, history, turns]);

  // Cold actionable pending with stamp ⇒ unlock composer (desktop finalizeGenerating
  // parity). Submitting / resume_deferred wait keeps 提交中态 — do not clear sending.
  useEffect(() => {
    if (!sending) return;
    const hasActionable = visibleResumes.some(
      (p) =>
        (p.interactionStatus ?? "pending") === "pending" &&
        !p.deferredBusyReason,
    );
    if (hasActionable) setSending(false);
  }, [visibleResumes, sending]);

  // Stage picked files (composer 附件). Text is extracted; images/binary are resident-first
  // (upload when a conversation exists, else hold File until first send). The input is reset
  // so re-picking the same file fires onChange again.
  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setAttachError(null);
    const added: MessageAttachment[] = [];
    const refused: string[] = [];
    for (const file of files) {
      const res = await prepareAttachment(file, conversationId ?? null);
      if (res.ok) added.push(res.attachment);
      else refused.push(`${file.name}：${res.reason}`);
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    if (refused.length > 0) setAttachError(refused.join("；"));
  }

  function removeAttachment(name: string) {
    setAttachments((prev) => prev.filter((a) => a.name !== name));
  }

  // Ask / debate handoff → fill the composer (don't auto-send: let the user edit first).
  // Appends after a space when text is already typed, so a fill never clobbers it.
  function fillComposer(text: string) {
    setInput((prev) => (prev.trim() ? `${prev} ${text}` : text));
    composerInputRef.current?.focus();
  }

  // 会话级模型组合 (定案 B): apply a concrete profile from the ModelPicker. Remembered as
  // last-used. An open conversation is PATCHed now; a draft holds it until startDraft
  // snapshots it via POST model_profile_id.
  async function onSelectProfile(profileId: string) {
    setPickerOpen(false);
    setLastModelProfileId(profileId);
    if (!conversationId) {
      setCurrentProfileId(profileId);
      return;
    }
    const previous = currentProfileId;
    setCurrentProfileId(profileId);
    try {
      const updated = await setConversationModelProfile(
        conversationId,
        profileId,
      );
      setCurrentProfileId(updated.model_profile_id ?? null);
    } catch (e) {
      setCurrentProfileId(previous);
      setError({ text: e instanceof Error ? e.message : "切换模型组合失败" });
    }
  }

  // 直接对话: a draft (no conversationId) lazily creates a conversation on first send, then
  // routes to /c/:id where the remounted page POST+streams the message (via pendingFirstSend).
  // Keeps the empty-shell-conversation cost off「新建」— the row only exists once you commit.
  async function startDraft() {
    const text = input.trim();
    if (!hasSendableDraft(text, attachments) || conversationId || busy) return;
    const outgoing = attachments;
    setError(null);
    setSending(true);
    try {
      // 定案 B: snapshot chosen / last-used profile at create (omit → server writes then-default).
      const id = await createConversation(undefined, {
        ...(permissionDraftTouched ? { permission_axes: permissionAxes } : {}),
        ...(currentProfileId ? { model_profile_id: currentProfileId } : {}),
      });
      pendingFirstSend = { id, text, attachments: outgoing };
      setInput("");
      setAttachments([]);
      setAttachError(null);
      navigate(`/c/${id}`, { replace: true });
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : "创建会话失败" });
      setSending(false);
    }
  }

  // Submit dispatch: a draft creates-then-routes (startDraft); an open conversation streams
  // in place (send). The composer / Enter both go through here.
  // 生成中：默认 queue；显式插队走 sendForcedSteer。
  const onSubmit = (deliveryOverride?: MessageDelivery) => {
    if (conversationId) void send(undefined, deliveryOverride);
    else void startDraft();
  };

  const sendForcedSteer = () => {
    if (!conversationId || !hasSendableDraft(input, attachments)) return;
    void send(undefined, "steer");
  };

  /** 取消 FIFO 排队项（Stop ≠ 取消排队）：只清条 + abort mid-flight。 */
  function applyQueueCancelLocal(entry: QueuedTurnEntry) {
    removeQueuedTurn(entry.conversationId, entry.queueId);
    const ac = midFlightByQueueRef.current.get(entry.queueId);
    if (ac) {
      ac.abort();
      midFlightByQueueRef.current.delete(entry.queueId);
      midFlightControllersRef.current.delete(ac);
    }
  }

  // Stream a turn into the open conversation. `override` carries a draft's first message
  // across the remount (it bypasses the input state, which the new page doesn't have).
  // 生成中再发走 mid-flight（turn_queued / user_interjection），composer 不禁发。
  async function send(
    override?: {
      text: string;
      attachments: MessageAttachment[];
    },
    deliveryOverride?: MessageDelivery,
  ) {
    const text = (override?.text ?? input).trim();
    const outgoing = override?.attachments ?? attachments;
    if (!hasSendableDraft(text, outgoing) || !conversationId) return;
    if (stopPhaseRef.current === "stopping") return;
    // Interactive mid-flight while a turn is already streaming.
    if (!override && sending) {
      const delivery = deliveryOverride ?? defaultDelivery({ busy: true });
      void sendWhileBusy(text, delivery);
      return;
    }
    let wireAttachments: Array<Omit<MessageAttachment, "fileBlob">> = [];
    if (outgoing.length > 0) {
      const finalized = await finalizeAttachmentsForSend(
        conversationId,
        outgoing,
      );
      if (!finalized.ok) {
        setAttachError(finalized.reason);
        return;
      }
      wireAttachments = finalized.attachments;
    }
    if (!override) {
      setInput("");
      setAttachments([]);
    }
    setAttachError(null);
    setError(null);
    clearStopping();
    markStreamStart();
    primaryActiveRef.current = true;
    jumpToBottom();
    const turnId = crypto.randomUUID();
    setActiveTurn(turnId);
    setTurns((t) => [
      ...t,
      {
        id: turnId,
        userText: text,
        events: [],
        attachments: wireAttachments.map((a) => ({
          name: a.name,
          truncated: a.truncated,
        })),
      },
    ]);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamMessage(
        conversationId,
        text,
        (event) => appendEventToTurn(turnId, event),
        ac.signal,
        wireAttachments.length > 0 ? wireAttachments : undefined,
        "steer",
      );
    } catch (e) {
      if (isAbort(e)) return; // conversation switch — partial stays, server salvages
      // Pre-stream refusal (402 LLM_KEY_REQUIRED etc.) — surface banner +「去配置」, do not
      // treat as a dropped live run (nothing started).
      if (e instanceof StreamHttpError) {
        const d = describeStreamHttpError(e);
        setError({
          text: d.message,
          action: d.action ?? undefined,
        });
        return;
      }
      // 诚实停止等待中断流：不自动重连，保持 stopping 等引擎终态。
      if (isStoppingNow()) return;
      // A mid-stream drop no longer means the turn died (slice 1a: it runs detached) —
      // rejoin it (1b) rather than resending, which would double-run it.
      await reconnect();
    } finally {
      signalPrimaryIdle();
      // Only settle sending if still the current op — a switch / takeover (reconnect /
      // mid-flight turn2) replaced the controller and owns the state now.
      if (abortRef.current === ac) {
        abortRef.current = null;
        markStreamEnd();
      } else {
        inflightRef.current = Math.max(0, inflightRef.current - 1);
      }
    }
  }

  /** 生成中发送：独立 POST SSE；queue → 仅条；出队开跑再进主时间线用户泡。 */
  async function sendWhileBusy(text: string, delivery: MessageDelivery) {
    if (!conversationId) return;
    const outgoing = attachments;
    let wireAttachments: Array<Omit<MessageAttachment, "fileBlob">> = [];
    if (outgoing.length > 0) {
      const finalized = await finalizeAttachmentsForSend(
        conversationId,
        outgoing,
      );
      if (!finalized.ok) {
        setAttachError(finalized.reason);
        return;
      }
      wireAttachments = finalized.attachments;
    }
    // ack 前不清：等 turn_queued / steer / 插话确认后再清（勿等整段泵）。
    setAttachError(null);
    setError(null);
    jumpToBottom();
    markStreamStart();

    const ac = new AbortController();
    midFlightControllersRef.current.add(ac);
    let queuedTurnId: string | null = null;
    let trackedQueueId: string | null = null;
    let composerCleared = false;
    const clearComposerOnAck = () => {
      if (composerCleared) return;
      composerCleared = true;
      setInput("");
      setAttachments([]);
    };

    try {
      const result = await sendMidFlightMessage(
        conversationId,
        text,
        {
          onLiveEvent: (event) => {
            // 插话 ack：清输入并写入当前主路；turn_queued 由 onQueued 处理。
            if (event.type === "turn_queued") return;
            if (event.type === "user_interjection") {
              clearComposerOnAck();
            }
            appendEventToTurn(activeTurnIdRef.current, event);
          },
          onQueued: (info) => {
            // 仅 QueuedTurnsBar；排队期不插主时间线用户泡。
            clearComposerOnAck();
            trackedQueueId = info.queueId;
            midFlightByQueueRef.current.set(info.queueId, ac);
            upsertQueuedTurn({
              queueId: info.queueId,
              conversationId,
              content: text,
              position: info.position,
              queueDepth: info.queueDepth,
              degradedFrom: info.degradedFrom,
            });
          },
          beginTurn2: () => {
            // 出队开跑：插入主时间线用户泡，并接管 abort 槽。
            // 条由 turn_queue_started（sink 首帧）清，勿在此猜出队。
            if (!queuedTurnId) {
              const turnId = crypto.randomUUID();
              queuedTurnId = turnId;
              setTurns((t) => [
                ...t,
                {
                  id: turnId,
                  userText: text,
                  events: [],
                  attachments: wireAttachments.map((a) => ({
                    name: a.name,
                    truncated: a.truncated,
                  })),
                },
              ]);
            }
            setActiveTurn(queuedTurnId);
            abortRef.current = ac;
          },
          onTurn2Event: (event) => {
            appendEventToTurn(queuedTurnId, event);
          },
          isPrimaryIdle: () => !primaryActiveRef.current,
          waitPrimaryIdle,
        },
        wireAttachments.length > 0 ? wireAttachments : undefined,
        ac.signal,
        delivery,
      );
      if (result.kind === "blocked") {
        setError({ text: result.message ?? "请先处理待确认事项" });
      } else if (result.kind === "error") {
        setError({ text: result.message });
      } else if (result.kind === "received" || result.kind === "queued") {
        // 泵已结束时仍兜底清一次（ack 回调已清则 no-op）。
        clearComposerOnAck();
      }
    } finally {
      midFlightControllersRef.current.delete(ac);
      if (trackedQueueId) {
        midFlightByQueueRef.current.delete(trackedQueueId);
      }
      if (abortRef.current === ac) {
        abortRef.current = null;
      }
      markStreamEnd();
    }
  }

  // 诚实停止闭环：进入「停止中」可见态，POST /stop，保持 SSE 等后端终态（不本地 abort /
  // 不伪造终态）。/stop 失败 → 回滚 idle + 诚实失败提示，可再点停止。
  function stop() {
    if (!busy && stopPhaseRef.current !== "stopping") return;
    if (!conversationId) {
      // Draft edge: no server run yet — local abort only.
      abortRef.current?.abort();
      return;
    }
    setError(null);
    applyStopPhase(reduceStopPhase(stopPhaseRef.current, "request_stop"));
    void stopConversation(conversationId).catch(() => {
      if (stopPhaseRef.current !== "stopping") return;
      applyStopPhase(reduceStopPhase("stopping", "stop_http_fail"));
      setError({ text: STOP_FAILED_MESSAGE });
    });
  }

  // Rejoin a turn whose live stream dropped mid-flight (实时重连续看 C1 · slice 1b). Resets
  // the partial bubble (the replay re-sends the full transcript-so-far) then attaches:
  // replay + live tail. On "none" the detached run already finished — reload the persisted
  // transcript so the live turn is replaced by its saved reply. A second drop offers a
  // manual 重连.
  // 出队开跑后队尾可能是新 turn——目标须跟 activeTurnIdRef（与投影约定一致），禁 turns[-1]。
  async function reconnect() {
    if (!conversationId) return;
    setError(null);
    clearStopping();
    setSending(true);
    // SSE 重连后对账排队条（权威 GET）。
    reconcileQueuedRef.current(conversationId);
    const reconnectTurnId = activeTurnIdRef.current;
    if (reconnectTurnId) setActiveTurn(reconnectTurnId);
    setTurns((t) => clearLiveTurnEvents(t, reconnectTurnId));
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const outcome = await attachStream(
        conversationId,
        appendEvent,
        ac.signal,
      );
      if (outcome === "none" && abortRef.current === ac) {
        setTurns((t) => removeLiveTurn(t, reconnectTurnId));
        const {
          messages,
          hasMoreBefore: more,
          memoryUpdates: mem,
        } = await getMessages(conversationId);
        if (abortRef.current === ac) {
          setHistory(messages);
          setHasMoreBefore(more);
          setMemoryUpdates(mem);
        }
      }
    } catch (e) {
      if (isAbort(e)) return;
      if (stopPhaseRef.current === "stopping") return;
      setError({ text: RECONNECT_BANNER, reconnect: true });
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  // P4: interrupted salvage → regenerate from the preceding user message (same endpoint
  // as desktop runRegenerate; no new API).
  async function retryInterrupted() {
    if (!conversationId || !history || busy) return;
    const last = history[history.length - 1];
    if (!last || last.role !== "assistant") return;
    let userId: string | null = null;
    for (let i = history.length - 2; i >= 0; i--) {
      if (history[i].role === "user") {
        userId = history[i].id;
        break;
      }
    }
    if (!userId) return;
    setError(null);
    clearStopping();
    setSending(true);
    // Drop interrupted assistant from history; live turn carries the regenerate stream.
    setHistory((h) => (h ? h.slice(0, -1) : h));
    const turnId = crypto.randomUUID();
    setActiveTurn(turnId);
    setTurns([
      {
        id: turnId,
        userText: null,
        events: [],
      },
    ]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await regenerateStream(
        conversationId,
        userId,
        (event) => appendEventToTurn(turnId, event),
        ac.signal,
      );
    } catch (e) {
      if (isAbort(e)) return;
      if (e instanceof StreamHttpError) {
        const d = describeStreamHttpError(e);
        setError({
          text: d.message,
          action: d.action ?? undefined,
        });
        return;
      }
      setError({ text: e instanceof Error ? e.message : "重试失败" });
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  // On reopen, rejoin a run that may still be live for the latest (reply-less) turn. Unlike
  // reconnect there is no partial bubble to reset — the reopened transcript ends at the
  // user message; appendEvent lazily opens the assistant bubble, so a 204 (nothing live)
  // is a clean no-op with no flicker. Identity-guarded (`abortRef.current === ac`) so a
  // conversation switch / takeover never lets this stale op clobber the next view.
  async function attachOnOpen(cid: string) {
    setSending(true);
    // 续看 attach 亦对账（重开应用条空但队仍在 / 多端）。
    reconcileQueuedRef.current(cid);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const outcome = await attachStream(cid, appendEvent, ac.signal);
      if (outcome === "none" && abortRef.current === ac) {
        // Finished / never ran / suspended — reload to catch a reply that landed between
        // the history load and the attach (a suspended turn surfaces via durable resume).
        const {
          messages,
          hasMoreBefore: more,
          memoryUpdates: mem,
        } = await getMessages(cid);
        if (abortRef.current === ac) {
          setHistory(messages);
          setHasMoreBefore(more);
          setMemoryUpdates(mem);
        }
      }
    } catch (e) {
      if (isAbort(e)) return;
      if (stopPhaseRef.current === "stopping") return;
      setError({ text: RECONNECT_BANNER, reconnect: true });
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  // P4 clear-then-fold: history already shows a running overlay partial — drop it so the
  // full journal replay does not double-fold tools/content, then attach live.
  async function rejoinRunningHistory(cid: string) {
    setError(null);
    setSending(true);
    reconcileQueuedRef.current(cid);
    setHistory((h) => {
      if (!h || h.length === 0) return h;
      const last = h[h.length - 1];
      if (last.role === "assistant") return h.slice(0, -1);
      return h;
    });
    setTurns([]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const outcome = await attachStream(cid, appendEvent, ac.signal);
      if (outcome === "none" && abortRef.current === ac) {
        const {
          messages,
          hasMoreBefore: more,
          memoryUpdates: mem,
        } = await getMessages(cid);
        if (abortRef.current === ac) {
          setHistory(messages);
          setHasMoreBefore(more);
          setMemoryUpdates(mem);
        }
      }
    } catch (e) {
      if (isAbort(e)) return;
      if (stopPhaseRef.current === "stopping") return;
      setError({ text: RECONNECT_BANNER, reconnect: true });
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  // 挂起即收口 (②): re-read the conversation's recovery snapshot — used when a live stream
  // ends at a checkpoint (appendEvent sees message_end finish_reason=paused) so the just-
  // finalized turn's durable ResumeCard surfaces. Live paint prefers cold IX; this syncs
  // the recovery shell. Cheap + idempotent; best-effort.
  async function refreshPaused(cid: string) {
    try {
      const r = await getRecovery(cid);
      setPaused(r.paused);
      for (const p of r.paused) {
        if (!isColdResumeKind(p.kind)) continue;
        upsertColdRequired({
          kind: p.kind,
          conversationId: cid,
          messageId: p.message_id,
          payload: pausedSummaryToRequiredPayload(p),
          status: "pending",
        });
      }
    } catch {
      /* best-effort: never break the just-finished turn on a recovery refresh */
    }
  }

  // Continue a durably-paused turn (结构化挂起 2b). Option A: reuse the paused
  // assistant by server message_id (same bubble → streaming) — never push a second
  // assistant turn (dual TeamView). Desktop parity: resumePausedAssistant / runResume.
  // Busy slot → EPHEMERAL resume_deferred on the same SSE (not 409); card stays as
  // 「放行已记下…」until claim+续跑. Mid-stream drop rejoins rather than re-resumes.
  async function resume(
    messageId: string,
    decision: CheckpointDecision,
    note: string,
    selected: string[] = [],
    amendments?: TeamPreviewAmendments,
  ) {
    if (!conversationId || busy) return;
    const coldTargets = listColdPending(conversationId).filter(
      (e) => e.messageId === messageId,
    );
    const resolution = { decision, note, selected };
    for (const e of coldTargets) {
      markColdSubmitting({
        kind: e.kind,
        id: e.id,
        resolution,
      });
    }
    setPaused((p) => p.filter((x) => x.message_id !== messageId));
    setError(null);
    clearStopping();
    setSending(true);
    const prepared = prepareResumePausedTurn({
      messageId,
      turns,
      history,
      newTurnId: crypto.randomUUID(),
    });
    const turnId = prepared.turnId;
    // setActiveTurn clears host stamp when the active turn id changes — re-seal
    // after so ask_user continue → same-turn team_preview keeps the projection key.
    setActiveTurn(turnId);
    hostServerMessageIdRef.current = messageId;
    setTurns(prepared.turns);
    if (prepared.history !== history) setHistory(prepared.history);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // stop / adjust / ask·debate：不带组队修正；delegate continue 才附写盘收紧
      //（确认面不附 excluded_run_ids / model_overrides；契约类型字段仍可保留）。
      const body: ResumeTurnBody = { decision, note, selected };
      if (decision === "continue" && amendments) {
        const hasWrite =
          (amendments.write_capability_overrides?.length ?? 0) > 0;
        const hasModels =
          !!amendments.model_overrides &&
          Object.keys(amendments.model_overrides).length > 0;
        if (hasWrite || hasModels) {
          if (hasWrite) {
            body.write_capability_overrides =
              amendments.write_capability_overrides;
          }
          if (hasModels) body.model_overrides = amendments.model_overrides;
        }
      }
      await resumeStream(
        conversationId,
        messageId,
        body,
        (event) => appendEventToTurn(turnId, event),
        ac.signal,
      );
      // Stream settled without an earlier message_start settle — drop submitting cards.
      for (const e of coldTargets) {
        if (getColdInteraction(e.id)?.status === "submitting") {
          markColdResolved({ kind: e.kind, id: e.id, resolution });
        }
      }
    } catch (err) {
      for (const entry of coldTargets) {
        const cur = getColdInteraction(entry.id);
        // Deferred 后 settlement 已锁：断连不清「已记下」；仅 claim 前失败才恢复可编辑。
        if (cur?.deferredBusyReason) continue;
        reopenColdPending(entry.id);
      }
      if (isAbort(err)) return;
      if (stopPhaseRef.current === "stopping") return;
      await reconnect();
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  /** 推进卡 resolve：起新回合 SSE（机制直起辩论或回灌调研）。 */
  async function runStageCard(
    stageCardId: string,
    body: {
      decision: "start_debate" | "research_first";
      note?: string;
      motionOverride?: string | null;
    },
  ): Promise<void> {
    if (!conversationId || busy) return;
    setRecoveredInteractions((prev) =>
      prev.filter((a) => a.id !== stageCardId),
    );
    setError(null);
    clearStopping();
    setSending(true);
    const turnId = crypto.randomUUID();
    setActiveTurn(turnId);
    setTurns((t) => [...t, { id: turnId, userText: null, events: [] }]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await resolveStageCardStream(
        conversationId,
        stageCardId,
        body,
        (event) => appendEventToTurn(turnId, event),
        ac.signal,
      );
    } catch (e) {
      if (isAbort(e)) return;
      if (e instanceof StreamHttpError && e.status === 422) {
        // 检定失败：撤回本空回合（按 id，禁 slice(-1)——期间可能已插排队泡）
        setTurns((t) => removeLiveTurn(t, turnId));
        setSending(false);
        abortRef.current = null;
        throw e;
      }
      if (stopPhaseRef.current === "stopping") return;
      await reconnect();
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  // 当前组合：会话快照 → account default 展示名 → placeholder（「＋」菜单展示）。
  const modelLabel =
    profileDisplayLabel(modelProfiles, currentProfileId) ?? "默认组合";
  const permissionLabel = axesShortLabel(permissionAxes);
  const composerLocked = history === null || stopPhase === "stopping";
  const hasDraft = hasSendableDraft(input, attachments);
  const trailing = composerTrailingSlots({
    busy,
    hasDraft,
    voiceSupported: voice.isSupported,
    voiceActive: voice.isRecording || voice.state === "processing",
  });

  // Auto-grow textarea (cap ~5 lines) so multi-line drafts don't steal the button row.
  // useLayoutEffect + assign `el.value = input` so the dep is real (not a fake trigger)
  // and programmatic setInput (voice/chip/clear) still remeasures before paint.
  useLayoutEffect(() => {
    const el = composerInputRef.current;
    if (!el) return;
    el.value = input;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  return (
    <div className="screen">
      <header className="bar">
        <button
          type="button"
          className="link icon-btn"
          aria-label="对话历史"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={20} />
        </button>
        <span className="bar-title">{conversationId ? "对话" : "新对话"}</span>
        <div className="bar-right">
          {conversationId && (
            <button
              type="button"
              className="link icon-btn"
              aria-label="文件"
              onClick={() => navigate(`/c/${conversationId}/files`)}
            >
              <Folder size={20} />
            </button>
          )}
          <button
            type="button"
            className="link icon-btn"
            aria-label="新对话"
            onClick={() => navigate("/")}
          >
            <SquarePen size={20} />
          </button>
        </div>
      </header>

      <div className="messages-pane">
        <div className="messages" ref={scrollRef}>
          {history === null && !error && <p className="muted hint">加载中…</p>}
          {history !== null &&
            history.length === 0 &&
            turns.length === 0 &&
            !error &&
            (() => {
              // 平台代付、开箱即用：无「先接入模型」门，keyless 直接进欢迎态。
              if (conversationId) {
                return <p className="muted hint">发一条消息开始对话。</p>;
              }
              const copy = emptyChatCopy();
              return (
                <div className="chat-welcome">
                  <div className="chat-welcome-title">{copy.title}</div>
                  <div className="chat-welcome-sub">{copy.subtitle}</div>
                </div>
              );
            })()}
          {hasMoreBefore && (
            <button
              type="button"
              className="load-older"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
            >
              {loadingOlder ? "加载中…" : "加载更早的消息"}
            </button>
          )}
          {history?.map((m, i) => {
            if (m.role !== "user")
              return (
                <HistoryAssistant
                  key={m.id}
                  m={m}
                  conversationId={conversationId ?? null}
                  onFill={fillComposer}
                  isLast={i === history.length - 1 && turns.length === 0}
                  onRetry={
                    i === history.length - 1 && turns.length === 0
                      ? () => void retryInterrupted()
                      : undefined
                  }
                />
              );
            const atts = m.attachments ?? [];
            if (!m.content && atts.length === 0) return null;
            // 异步团队收口：识别后隐藏（不渲染用户气泡，避免露出模型提示词）
            if (
              m.role === "user" &&
              (m.origin === "execution_harvest" ||
                (typeof m.content === "string" &&
                  m.content.startsWith("【系统收口】")))
            ) {
              return null;
            }
            return (
              <div key={m.id} className="bubble user">
                {m.content ? (
                  <CollapsibleUserText contentKey={m.content}>
                    {m.content}
                  </CollapsibleUserText>
                ) : null}
                <AttachmentChips items={atts} />
              </div>
            );
          })}
          {turns.map((turn) => {
            const isLiveStream =
              busy &&
              activeStreamTurnId != null &&
              turn.id === activeStreamTurnId;
            const showAssistant =
              turn.events.length > 0 || isLiveStream || turn.userText === null;
            return (
              <div key={turn.id} className="turn">
                <UserTurnBubble turn={turn} />
                {showAssistant ? (
                  <AssistantBubble
                    turn={turn}
                    live={isLiveStream}
                    conversationId={conversationId ?? null}
                    onFill={fillComposer}
                    onOpenBrowserLive={
                      conversationId ? openBrowserLive : undefined
                    }
                  />
                ) : null}
              </div>
            );
          })}
          {/* 「记忆已更新」卡 (③ §1.6): offline-consolidation results pinned at the thread tail
              — it post-dates every turn (consolidation folds a window of finished turns). The
              card filters empty updates itself, so the common (none) case renders nothing. */}
          <MemoryUpdateCard updates={memoryUpdates} />
        </div>
        {!atBottom && (history?.length || turns.length) ? (
          <button
            type="button"
            className="jump-bottom"
            onClick={jumpToBottom}
            aria-label="回到底部"
          >
            <ArrowDown size={14} aria-hidden />
            回到底部
          </button>
        ) : null}
      </div>

      {approvalCards.map((pending) =>
        conversationId ? (
          <PauseCard
            key={pending.id}
            pending={pending}
            conversationId={conversationId}
            onResolved={() =>
              setRecoveredInteractions((prev) =>
                prev.filter((a) => a.id !== pending.id),
              )
            }
          />
        ) : null,
      )}
      {delegationCards.map((pending) =>
        conversationId ? (
          <DelegationAuthorizationCard
            key={pending.id}
            pending={pending}
            conversationId={conversationId}
            onResolved={() =>
              setRecoveredInteractions((prev) =>
                prev.filter((a) => a.id !== pending.id),
              )
            }
          />
        ) : null,
      )}

      {!busy &&
        conversationId &&
        escalationCards.map((card) => (
          <EscalationAnswer
            key={card.id}
            esc={card.esc}
            escalationId={card.id}
            conversationId={conversationId}
            runId={card.runId || undefined}
            onOpenLive={openBrowserLive}
            onResolved={() => {
              setRecoveredInteractions((prev) =>
                prev.filter((a) => a.id !== card.id),
              );
              void attachOnOpen(conversationId);
            }}
          />
        ))}

      {/* Durable resume cards — live authority = cold Interaction pending + stamp;
          recovery `paused` is reopen shell. Not gated on !busy (stamp may land while
          stream still draining; sending unlocks via visibleResumes effect). */}
      {visibleResumes.map((p) => (
        <ResumeCard
          key={`${p.message_id}:${p.checkpoint_id}`}
          paused={p}
          onResume={(decision, note, selected, amendments) =>
            void resume(p.message_id, decision, note, selected, amendments)
          }
          onOpenLive={conversationId ? openBrowserLive : undefined}
        />
      ))}

      {!busy &&
        conversationId &&
        stageCards.map((card) => (
          <StageCard
            key={card.id}
            card={card}
            onResolve={async (args) => {
              await runStageCard(card.id, args);
            }}
          />
        ))}

      {error && (
        <div className="error bar">
          <span>{error.text}</span>
          <div className="error-bar-actions">
            {conversationId && (
              <SupportDiagnosticCopyButton ids={{ conversationId }} />
            )}
            {error.action && (
              <button
                type="button"
                className="link config-action"
                onClick={() => {
                  const href = error.action?.href;
                  if (!href) return;
                  setError(null);
                  navigate(href);
                }}
              >
                {error.action.label}
              </button>
            )}
            {error.reconnect && (
              <button
                type="button"
                className="link reconnect"
                onClick={() => void reconnect()}
              >
                重连
              </button>
            )}
          </div>
        </div>
      )}

      {attachError && (
        <div className="error bar">
          <span>{attachError}</span>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attach-tray">
          {attachments.map((a) => (
            <span key={a.name} className="attach-chip">
              <span aria-hidden>📎</span>
              <span className="attach-chip-name">{a.name}</span>
              {a.truncated && <span className="attach-chip-trunc">已截断</span>}
              <button
                type="button"
                className="attach-chip-x"
                onClick={() => removeAttachment(a.name)}
                aria-label="移除附件"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {voice.error && (
        <div className="error bar">
          <span>{voice.error}</span>
          <button type="button" className="link" onClick={voice.dismissError}>
            知道了
          </button>
        </div>
      )}

      {queueDroppedHint && (
        <div
          className="composer-delivery-hint"
          data-testid="queue-dropped-hint"
          // biome-ignore lint/a11y/useSemanticElements: 内嵌「知道了」按钮，<output> 语义不符——保留 aria live 容器。
          role="status"
        >
          <span>{queueDroppedHint}</span>
          <button
            type="button"
            className="queue-link"
            onClick={() => setQueueDroppedHint(null)}
          >
            知道了
          </button>
        </div>
      )}

      <QueuedTurnsBar
        conversationId={conversationId ?? null}
        onCancelled={(entry) => applyQueueCancelLocal(entry)}
        onCancelFailed={(text) => setError({ text })}
      />
      {voice.isRecording && (
        <VoiceRecordingBar
          duration={voice.duration}
          interimText={voice.interimText}
          onCancel={voice.cancel}
        />
      )}

      {/* 生成中有草稿：插队入口收到行外轻链（对齐桌面 Ctrl+Enter，不挤主槽）。 */}
      {trailing.showSteerHint && (
        <div
          className="composer-delivery-hint"
          data-testid="composer-delivery-hint"
        >
          <span>发送将排队至下一回合</span>
          <button
            type="button"
            className="queue-link"
            onClick={() => void sendForcedSteer()}
            disabled={history === null || stopPhase === "stopping"}
            aria-label={interruptible ? "插话" : "插队"}
            title={
              interruptible ? "插话（插入当前回合）" : "插队（插入当前回合）"
            }
            data-testid="force-steer-btn"
          >
            插队
          </button>
        </div>
      )}

      <div className="composer">
        <input
          ref={attachInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => void onPickFiles(e)}
        />
        <button
          type="button"
          className="attach-btn"
          onClick={() => setMoreOpen(true)}
          disabled={composerLocked}
          aria-label="更多选项"
          aria-expanded={moreOpen}
          title="更多"
        >
          ＋
        </button>
        <textarea
          ref={composerInputRef}
          className="composer-input"
          rows={1}
          placeholder={history === null ? "加载中…" : "说点什么…"}
          value={input}
          disabled={composerLocked}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            // IME 组合态（中文选词等）：Enter 确认候选，勿当发送。
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            e.preventDefault();
            void onSubmit();
          }}
        />
        {/* 态敏主槽：空闲空草稿=麦；有字=发送；生成中=Stop（有草稿时主发=queue，行外插队）。 */}
        {trailing.row.map((slot) => {
          if (slot === "send") {
            return (
              <button
                key={slot}
                type="button"
                className="send-btn"
                onClick={() => void onSubmit()}
                disabled={history === null || !hasDraft}
                aria-label="发送"
                title="发送"
              >
                <Send size={18} aria-hidden />
              </button>
            );
          }
          if (slot === "stop") {
            return (
              <button
                key={slot}
                type="button"
                className={`stop${stopPhase === "stopping" ? " stopping" : ""}`}
                onClick={stop}
                aria-label={stopButtonLabel(stopPhase)}
                title={stopButtonLabel(stopPhase)}
                aria-busy={stopPhase === "stopping"}
              >
                {stopPhase === "stopping" ? (
                  <Loader2 size={18} className="voice-spin" aria-hidden />
                ) : (
                  <Square size={16} aria-hidden />
                )}
              </button>
            );
          }
          return (
            <VoiceButton
              key={slot}
              state={voice.state}
              disabled={composerLocked}
              onClick={voice.toggle}
            />
          );
        })}
      </div>

      {moreOpen && (
        <ComposerMoreSheet
          modelLabel={modelLabel}
          permissionLabel={permissionLabel}
          disabled={history === null || busy}
          onClose={() => setMoreOpen(false)}
          onOpenModel={() => {
            setMoreOpen(false);
            setPickerOpen(true);
          }}
          onOpenPermission={() => {
            setMoreOpen(false);
            setPermissionSheetOpen(true);
          }}
          onAttach={() => {
            setMoreOpen(false);
            attachInputRef.current?.click();
          }}
        />
      )}

      {pickerOpen && (
        <ModelPicker
          conversationProfileId={currentProfileId}
          onSelect={(id) => void onSelectProfile(id)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {permissionSheetOpen && (
        <PermissionAxesSheet
          conversationId={conversationId ?? null}
          axes={permissionAxes}
          disabled={history === null || busy}
          onAxesChange={(next) => {
            setPermissionAxes(next);
            if (!conversationId) setPermissionDraftTouched(true);
          }}
          onClose={() => setPermissionSheetOpen(false)}
          onError={(text) => setError({ text })}
        />
      )}

      <ConversationDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpen={() => setDrawerOpen(true)}
        activeId={conversationId}
      />

      {conversationId ? (
        <BrowserLiveSheet
          conversationId={conversationId}
          sessionId={browserLiveSessionId}
          open={browserLiveOpen}
          onClose={() => {
            setBrowserLiveOpen(false);
            setBrowserLiveSessionId(null);
          }}
        />
      ) : null}
    </div>
  );
}
