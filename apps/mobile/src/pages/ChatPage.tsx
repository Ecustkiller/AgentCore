import { getTokens } from "@/api/client";
import {
  type MemoryUpdate,
  type MessageDetail,
  createConversation,
  getMessages,
} from "@/api/conversations";
import {
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
import { getMessageCostTotal } from "@/api/usage";
import { AssistantContent } from "@/components/AssistantView";
import { ConversationDrawer } from "@/components/ConversationDrawer";
import { DebateSteeringCard } from "@/components/DebateSteeringCard";
import { DelegationAuthorizationCard } from "@/components/DelegationAuthorizationCard";
import { FileArtifactsCard } from "@/components/FileArtifactsCard";
import { MemoryUpdateCard } from "@/components/MemoryUpdateCard";
import { PauseCard } from "@/components/PauseCard";
import { ResumeCard } from "@/components/ResumeCard";
import { VoiceButton, VoiceRecordingBar } from "@/components/VoiceInput";
import { type MessageAttachment, readTextAttachment } from "@/lib/attachments";
import {
  fileArtifactsFromEvents,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import { useStickScroll } from "@/lib/useStickScroll";
import { useVoiceInput } from "@/lib/useVoiceInput";
import {
  extractAsks,
  extractFollowups,
  extractRunToolCalls,
  extractToolPhases,
  extractWorkerToolPhases,
  fold,
} from "@/protocol/fold";
import type {
  CheckpointDecision,
  DebateNarrativeRound,
  MessageEndPayload,
  SSEEvent,
  TurnWarningPayload,
} from "@agentcore/contract-types";
import type {
  ProjectedInteraction,
  ProjectedTurn,
} from "@agentcore/protocol-conformance";
import { ArrowDown, Folder, Menu, Sparkles, SquarePen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // Display-only chips for files this turn carried (the text rode the send body, not here).
  attachments?: { name: string; truncated?: boolean }[];
}

/** Attachment context chips on a user bubble (no download — the text rode the send body and
 *  now lives in the conversation workspace). `已截断` flags a file capped at 256KB. */
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

// A run keeps running detached after a dropped connection (执行与请求解耦 C1 · slice 1a),
// so a transport drop reconnects (rejoins the live run), never resends.
const RECONNECT_BANNER = "连接中断，回合仍在后台继续。点「重连」继续查看。";

/** A turn-level error with an optional one-tap reconnect (a held SSE that dropped while
 *  the run lives on). */
interface ChatError {
  text: string;
  reconnect?: boolean;
}

/** The user's 停止 (abort button), never surfaced as an error. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Format an integer nano-USD cost as a money caption (1 USD = 1e9). Returns null for
 *  0 / unknown so a free turn shows nothing, never「$0.00」(§7.5). */
function formatCost(nanoUsd: number | null | undefined): string | null {
  if (!nanoUsd || nanoUsd <= 0) return null;
  const usd = nanoUsd / 1e9;
  if (usd < 0.0001) return "<$0.0001";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

// A reloaded turn carries no cost in its MessageDetail (the ledger is the truth source);
// fetch it lazily per message, cached module-wide so re-renders / re-opens don't refetch.
const costCache = new Map<string, number>();
const costInflight = new Set<string>();

/** Lazily fetch a persisted turn's cost when its bubble scrolls into view (Intersection
 *  Observer — avoids an open-time request storm over a whole window). Returns the cached
 *  total; supplementary, so a failure just leaves the row uncosted. */
function useLazyMessageCost(messageId: string): {
  ref: React.RefObject<HTMLDivElement | null>;
  total: number | null;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [total, setTotal] = useState<number | null>(
    () => costCache.get(messageId) ?? null,
  );
  useEffect(() => {
    if (!messageId) return;
    if (costCache.has(messageId)) {
      setTotal(costCache.get(messageId) ?? null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      if (costCache.has(messageId)) {
        setTotal(costCache.get(messageId) ?? null);
        return;
      }
      if (costInflight.has(messageId)) return;
      costInflight.add(messageId);
      getMessageCostTotal(messageId)
        .then((t) => {
          costCache.set(messageId, t);
          setTotal(t);
        })
        .finally(() => costInflight.delete(messageId));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [messageId]);
  return { ref, total };
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

function recoveredDebate(
  a: PendingInteractionSummary,
): Extract<ProjectedInteraction, { kind: "debate_round" }> | null {
  if (a.kind !== "debate_round") return null;
  const p = a.payload ?? {};
  return {
    kind: "debate_round",
    id: a.id,
    status: "pending",
    executionId: typeof p.execution_id === "string" ? p.execution_id : "",
    moderatorRunId:
      typeof p.moderator_run_id === "string" ? p.moderator_run_id : "",
    roundNo: typeof p.round_no === "number" ? p.round_no : 0,
    focus: typeof p.focus === "string" ? p.focus : "",
    summary: typeof p.summary === "string" ? p.summary : "",
    converged: Boolean(p.converged),
    rationale: typeof p.rationale === "string" ? p.rationale : "",
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

function AssistantBubble({
  turn,
  live,
  conversationId,
  onFill,
}: {
  turn: Turn;
  live: boolean;
  conversationId: string | null;
  onFill: (text: string) => void;
}) {
  const p = useMemo(() => fold(turn.events), [turn.events]);
  // 本回合产出文件：实时回合从原始事件配对取（captain + worker 工具一网打尽）。
  const artifacts = useMemo(
    () => fileArtifactsFromEvents(turn.events),
    [turn.events],
  );
  // 非阻塞提问卡内容：随时间线 `ask` 标记原位呈现（旁路读原始事件，不入 ProjectedTurn）。
  const asks = useMemo(() => extractAsks(turn.events), [turn.events]);
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
  const meta = summarize(p);
  const isMulti = p.runs.length > 0;
  const team = isMulti
    ? {
        agents: p.agents,
        runs: p.runs,
        progress: p.progress,
        teamNotes: p.teamNotes,
        conversationId,
        pendingEscalations,
        escalationsInteractive: live,
        runToolCalls,
        workerToolPhases,
      }
    : undefined;
  const empty =
    !isMulti && p.process.length === 0 && !p.content && !p.reasoning;
  // 回合总账 — populated by message_end (null while streaming, so it appears on finish).
  const cost = formatCost(p.cost?.total);
  const turnWarning = p.turnWarning;
  return (
    <div className="bubble assistant">
      {turnWarning && <div className="turn-warning">{turnWarning}</div>}
      {empty ? (
        <span className="muted">{live ? "…" : ""}</span>
      ) : (
        <AssistantContent
          process={p.process}
          content={p.content}
          reasoning={p.reasoning}
          citations={p.citations}
          captainContext={p.captainContext}
          team={team}
          debate={p.debate}
          debateRounds={p.debateRounds}
          asks={asks}
          toolPhases={toolPhases}
          onFill={onFill}
        />
      )}
      <FileArtifactsCard
        artifacts={artifacts}
        conversationId={conversationId}
      />
      {/* The team view carries its own progress header; the one-line meta is the
          single-agent fallback. */}
      {!isMulti && meta && <div className="meta">{meta}</div>}
      {cost && <div className="cost">{cost}</div>}
    </div>
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
  const { team, debate, debateRounds, turnWarning } = useMemo(() => {
    const events = m.runs?.events;
    const warning =
      m.runs?.turn_warning ??
      (events?.length ? extractTurnWarning(events) : null);
    if (!events || events.length === 0)
      return {
        team: undefined,
        debate: null,
        debateRounds: [] as DebateNarrativeRound[],
        turnWarning: warning,
      };
    const p = fold(events);
    const team =
      p.runs.length > 0
        ? {
            agents: p.agents,
            runs: p.runs,
            progress: p.progress,
            teamNotes: p.teamNotes,
            runToolCalls: extractRunToolCalls(events),
          }
        : undefined;
    return {
      team,
      debate: p.debate,
      debateRounds: p.debateRounds,
      turnWarning: warning ?? p.turnWarning,
    };
  }, [m.runs]);
  const process = m.runs?.process ?? undefined;
  // 本回合产出文件：单聊读 runs.process，多 Agent 读 runs.events 日志；合并去重（另一支为空）。
  const artifacts = useMemo(
    () =>
      mergeArtifacts(
        fileArtifactsFromProcess(m.runs?.process ?? undefined),
        fileArtifactsFromEvents(m.runs?.events ?? []),
      ),
    [m.runs],
  );
  // 非阻塞提问卡内容：仅多 Agent 历史持久化 runs.events（单聊为空 → 无卡，与桌面一致）。
  const asks = useMemo(() => extractAsks(m.runs?.events ?? []), [m.runs]);
  // P2：优先用 messages.cost 列；缺列时仍 lazy-fetch 台账（旧行 / 未回写）。
  const columnTotal = m.cost?.total ?? null;
  const { ref, total: lazyTotal } = useLazyMessageCost(
    columnTotal == null ? m.id : "",
  );
  const cost = formatCost(columnTotal ?? lazyTotal);
  const streaming = m.status === "running";
  const interrupted =
    m.status === "incomplete" || m.runs?.finish_reason === "interrupted";

  if (
    !team &&
    (!process || process.length === 0) &&
    !m.content &&
    !m.reasoning_content &&
    m.citations.length === 0 &&
    artifacts.length === 0 &&
    !turnWarning &&
    !interrupted &&
    !streaming
  ) {
    return null;
  }
  return (
    <div
      className="bubble assistant"
      ref={columnTotal == null ? ref : undefined}
    >
      {turnWarning && <div className="turn-warning">{turnWarning}</div>}
      {interrupted && <div className="finish-chip muted">已中断，可重试</div>}
      {streaming && !m.content && !m.reasoning_content && !process?.length ? (
        <span className="muted">…</span>
      ) : (
        <AssistantContent
          process={process}
          content={m.content ?? ""}
          reasoning={m.reasoning_content ?? undefined}
          citations={m.citations}
          captainContext={m.runs?.captain_context ?? undefined}
          team={team}
          debate={debate}
          debateRounds={debateRounds}
          asks={asks}
          onFill={onFill}
        />
      )}
      <FileArtifactsCard
        artifacts={artifacts}
        conversationId={conversationId}
      />
      {interrupted && isLast && onRetry && (
        <button type="button" className="retry-btn" onClick={onRetry}>
          重试
        </button>
      )}
      {cost && !streaming && <div className="cost">{cost}</div>}
    </div>
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
  const [error, setError] = useState<ChatError | null>(null);
  // Files staged for the next send: their text rides the body (composer 附件). A pick that
  // can't be read as text (image / binary) surfaces `attachError` and isn't staged.
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  // The composer text input — focused after tapping a 下一步 chip so the user can edit/send.
  const composerInputRef = useRef<HTMLInputElement>(null);
  // Turns that paused at a checkpoint then lost their stream (durable resume frames),
  // surfaced as ResumeCards on reopen (结构化挂起 2b).
  const [paused, setPaused] = useState<PausedTurnSummary[]>([]);
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
  // The controller for the stream currently held open (send / reattach). 停止 aborts it.
  const abortRef = useRef<AbortController | null>(null);

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

  // Append an event to the live (last) turn — lazily opening a userText-less turn when
  // none exists yet (a reattach on reopen, whose user bubble is already in history).
  const appendEvent = (event: SSEEvent) => {
    setTurns((t) => {
      if (t.length === 0) {
        return [{ id: crypto.randomUUID(), userText: null, events: [event] }];
      }
      const next = t.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, event] };
      return next;
    });
    // 挂起即收口 (②): a live stream can END at a durable checkpoint — message_end carries
    // finish_reason=paused. The turn finalized (its in-process resolve Future was never
    // parked), so the live PauseCard no longer applies; re-read the recovery snapshot so
    // its durable ResumeCard surfaces once the stream settles (the single cold resume
    // path), exactly as a reopen would. One chokepoint for every stream
    // (send/resume/reconnect/attach), mirroring the desktop's message_end handler.
    if (
      conversationId &&
      event.type === "message_end" &&
      (event.payload as MessageEndPayload).finish_reason === "paused"
    ) {
      void refreshPaused(conversationId);
    }
  };

  // Load the persisted transcript for the conversation in the URL — this is what makes a
  // refresh keep the conversation (刷新不丢): the id rides the route, the history is the
  // server's. Turns sent this session stream live below it (via the fold). If the latest
  // turn has no persisted reply (ends at a user message), a run may still be live
  // (执行与请求解耦 C1 · slice 1b): rejoin it and 续看 it finish.
  useEffect(() => {
    if (!conversationId) {
      // Draft (直接对话): no server conversation yet — ready to type, nothing to load.
      setHistory([]);
      setTurns([]);
      setError(null);
      setSending(false);
      setPaused([]);
      setHasMoreBefore(false);
      setMemoryUpdates([]);
      return;
    }
    setHistory(null);
    setTurns([]);
    setError(null);
    setSending(false);
    setPaused([]);
    setRecoveredInteractions([]);
    setHasMoreBefore(false);
    setMemoryUpdates([]);
    let cancelled = false;
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
    void recoveryLoaded.then((r) => {
      if (!cancelled) {
        setPaused(r.paused);
        setRecoveredInteractions(r.pendingInteractions);
      }
    });
    getMessages(conversationId)
      .then(async ({ messages, hasMoreBefore: more, memoryUpdates }) => {
        if (cancelled) return;
        setHistory(messages);
        setHasMoreBefore(more);
        // 「记忆已更新」卡 (③ §1.6): only the latest window carries them — pin at the thread
        // tail. A (re)open/refresh loads them; scroll-up (loadOlder) never overwrites them,
        // matching desktop (mobile has no live firehose, so they surface on load, not push).
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
      abortRef.current?.abort();
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
  // held open (`sending`) and the fold reports a gate, the PauseCard below offers
  // resolution — equally for a fresh turn and one rejoined via reattach (a run paused at
  // an approval shows its live card on reconnect).
  const liveTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const liveProjection = useMemo(
    () => (liveTurn ? fold(liveTurn.events) : null),
    [liveTurn],
  );
  // 挂起即收口 (②, Phase 3): hot-path cards resolve live in-stream; cold path
  // (ask_user / plan_review / team_preview) finalizes and uses ResumeCard.
  const liveInteractions = sending
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
  const liveDebates = liveInteractions.filter(
    (i): i is Extract<ProjectedInteraction, { kind: "debate_round" }> =>
      i.kind === "debate_round",
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
  const debateCards =
    liveDebates.length > 0
      ? liveDebates
      : recoveredInteractions
          .map(recoveredDebate)
          .filter((x): x is NonNullable<typeof x> => x != null);

  // 下一步推荐 chips: live path matches followups_generated.message_id to this turn's
  // message_start; reload (no live turn) replays MessageDetail.followups on the latest
  // finished assistant. Retire when the next turn starts (`sending`).
  const followups = useMemo(() => {
    if (sending) return [];
    if (liveTurn) return extractFollowups(liveTurn.events);
    const last =
      history && history.length > 0 ? history[history.length - 1] : null;
    if (
      last?.role === "assistant" &&
      last.followups &&
      last.followups.length > 0
    ) {
      return last.followups;
    }
    return [];
  }, [sending, liveTurn, history]);

  // Stage picked files as text attachments (composer 附件). Each is read on the spot (the
  // pick is the grant); images / binaries are refused with a reason and skipped. The input
  // is reset so re-picking the same file fires onChange again.
  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setAttachError(null);
    const added: MessageAttachment[] = [];
    const refused: string[] = [];
    for (const file of files) {
      const res = await readTextAttachment(file);
      if (res.ok) added.push(res.attachment);
      else refused.push(`${file.name}：${res.reason}`);
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    if (refused.length > 0) setAttachError(refused.join("；"));
  }

  function removeAttachment(name: string) {
    setAttachments((prev) => prev.filter((a) => a.name !== name));
  }

  // Tap a 下一步 chip → fill the composer (don't auto-send: let the user edit first, like
  // desktop). Appends after a space when text is already typed, so a chip never clobbers it.
  function fillFollowup(text: string) {
    setInput((prev) => (prev.trim() ? `${prev} ${text}` : text));
    composerInputRef.current?.focus();
  }

  // 直接对话: a draft (no conversationId) lazily creates a conversation on first send, then
  // routes to /c/:id where the remounted page POST+streams the message (via pendingFirstSend).
  // Keeps the empty-shell-conversation cost off「新建」— the row only exists once you commit.
  async function startDraft() {
    const text = input.trim();
    if (!text || conversationId || sending) return;
    const outgoing = attachments;
    setError(null);
    setSending(true);
    try {
      const id = await createConversation();
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
  const onSubmit = () => {
    if (conversationId) void send();
    else void startDraft();
  };

  // Stream a turn into the open conversation. `override` carries a draft's first message
  // across the remount (it bypasses the input state, which the new page doesn't have).
  async function send(override?: {
    text: string;
    attachments: MessageAttachment[];
  }) {
    const text = (override?.text ?? input).trim();
    if (!text || !conversationId) return;
    // The handoff send (override) is an explicit one-shot (pendingFirstSend already cleared),
    // so it bypasses the 流式中 guard — that guard only debounces interactive double-sends.
    if (!override && sending) return;
    const outgoing = override?.attachments ?? attachments;
    if (!override) {
      setInput("");
      setAttachments([]);
    }
    setAttachError(null);
    setError(null);
    setSending(true);
    jumpToBottom();
    setTurns((t) => [
      ...t,
      {
        id: crypto.randomUUID(),
        userText: text,
        events: [],
        attachments: outgoing.map((a) => ({
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
        appendEvent,
        ac.signal,
        outgoing.length > 0 ? outgoing : undefined,
      );
    } catch (e) {
      if (isAbort(e)) return; // 停止 / conversation switch — partial stays, server salvages
      // A mid-stream drop no longer means the turn died (slice 1a: it runs detached) —
      // rejoin it (1b) rather than resending, which would double-run it.
      await reconnect();
    } finally {
      // Only settle if still the current op — a switch / takeover (reconnect) replaced the
      // controller and owns the state now (avoids a stale write clobbering it).
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  // Stop the held stream locally AND cancel the detached server run — a local abort alone
  // would leave it running + billing (a disconnect no longer cancels it, slice 1a).
  function stop() {
    abortRef.current?.abort();
    if (conversationId) void stopConversation(conversationId);
  }

  // Rejoin a turn whose live stream dropped mid-flight (实时重连续看 C1 · slice 1b). Resets
  // the partial bubble (the replay re-sends the full transcript-so-far) then attaches:
  // replay + live tail. On "none" the detached run already finished — reload the persisted
  // transcript so the live turn is replaced by its saved reply. A second drop offers a
  // manual 重连.
  async function reconnect() {
    if (!conversationId) return;
    setError(null);
    setSending(true);
    setTurns((t) => {
      if (t.length === 0) return t;
      const next = t.slice();
      next[next.length - 1] = { ...next[next.length - 1], events: [] };
      return next;
    });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const outcome = await attachStream(
        conversationId,
        appendEvent,
        ac.signal,
      );
      if (outcome === "none" && abortRef.current === ac) {
        setTurns((t) => t.slice(0, -1));
        const { messages, hasMoreBefore: more } =
          await getMessages(conversationId);
        if (abortRef.current === ac) {
          setHistory(messages);
          setHasMoreBefore(more);
        }
      }
    } catch (e) {
      if (!isAbort(e)) setError({ text: RECONNECT_BANNER, reconnect: true });
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
    if (!conversationId || !history || sending) return;
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
    setSending(true);
    // Drop interrupted assistant from history; live turn carries the regenerate stream.
    setHistory((h) => (h ? h.slice(0, -1) : h));
    setTurns([
      {
        id: crypto.randomUUID(),
        userText: null,
        events: [],
      },
    ]);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await regenerateStream(conversationId, userId, appendEvent, ac.signal);
    } catch (e) {
      if (isAbort(e)) return;
      if (!isAbort(e)) {
        setError({ text: e instanceof Error ? e.message : "重试失败" });
      }
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
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const outcome = await attachStream(cid, appendEvent, ac.signal);
      if (outcome === "none" && abortRef.current === ac) {
        // Finished / never ran / suspended — reload to catch a reply that landed between
        // the history load and the attach (a suspended turn surfaces via durable resume).
        const { messages, hasMoreBefore: more } = await getMessages(cid);
        if (abortRef.current === ac) {
          setHistory(messages);
          setHasMoreBefore(more);
        }
      }
    } catch (e) {
      if (!isAbort(e)) setError({ text: RECONNECT_BANNER, reconnect: true });
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
        const { messages, hasMoreBefore: more } = await getMessages(cid);
        if (abortRef.current === ac) {
          setHistory(messages);
          setHasMoreBefore(more);
        }
      }
    } catch (e) {
      if (!isAbort(e)) setError({ text: RECONNECT_BANNER, reconnect: true });
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

  // 挂起即收口 (②): re-read the conversation's recovery snapshot — used when a live stream
  // ends at a checkpoint (appendEvent sees message_end finish_reason=paused) so the just-
  // finalized turn's durable ResumeCard surfaces (it renders once `sending` flips false).
  // Cheap + idempotent; best-effort — a recovery hiccup must never disrupt the settled turn.
  async function refreshPaused(cid: string) {
    try {
      const r = await getRecovery(cid);
      setPaused(r.paused);
    } catch {
      /* best-effort: never break the just-finished turn on a recovery refresh */
    }
  }

  // Continue a durably-paused turn (结构化挂起 2b). The user's decision is POSTed to the
  // resume endpoint, which claims the persisted frame (atomic — a stale double-tap 404s)
  // and drives the rest of the turn on a fresh SSE; we stream it into a userText-less turn
  // (the paused turn's user bubble is already in history). The card is dropped
  // optimistically; a mid-stream drop rejoins the now-live run rather than re-resuming.
  async function resume(
    messageId: string,
    decision: CheckpointDecision,
    note: string,
  ) {
    if (!conversationId || sending) return;
    setPaused((p) => p.filter((x) => x.message_id !== messageId));
    setError(null);
    setSending(true);
    setTurns((t) => [
      ...t,
      { id: crypto.randomUUID(), userText: null, events: [] },
    ]);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await resumeStream(
        conversationId,
        messageId,
        { decision, note, selected: [] },
        appendEvent,
        ac.signal,
      );
    } catch (e) {
      if (isAbort(e)) return;
      await reconnect();
    } finally {
      if (abortRef.current === ac) {
        setSending(false);
        abortRef.current = null;
      }
    }
  }

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
            (conversationId ? (
              <p className="muted hint">发一条消息开始对话。</p>
            ) : (
              <div className="chat-welcome">
                <div className="chat-welcome-title">开始新对话</div>
                <div className="chat-welcome-sub">
                  向你的 Agent 团队提问，或交派一个任务。
                </div>
              </div>
            ))}
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
                  onFill={fillFollowup}
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
            return (
              <div key={m.id} className="bubble user">
                {m.content}
                <AttachmentChips items={atts} />
              </div>
            );
          })}
          {turns.map((turn, i) => (
            <div key={turn.id} className="turn">
              {turn.userText !== null && (
                <div className="bubble user">
                  {turn.userText}
                  <AttachmentChips items={turn.attachments ?? []} />
                </div>
              )}
              <AssistantBubble
                turn={turn}
                live={sending && i === turns.length - 1}
                conversationId={conversationId ?? null}
                onFill={fillFollowup}
              />
            </div>
          ))}
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
      {debateCards.map((pending) =>
        conversationId ? (
          <DebateSteeringCard
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

      {/* Durable resume cards (a turn that paused then lost its stream). Hidden while a
          stream is live — a live run owns the pause surface (PauseCard) instead. */}
      {!sending &&
        paused.map((p) => (
          <ResumeCard
            key={p.message_id}
            paused={p}
            onResume={(decision, note) =>
              void resume(p.message_id, decision, note)
            }
          />
        ))}

      {error && (
        <div className="error bar">
          <span>{error.text}</span>
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
      )}

      {attachError && (
        <div className="error bar">
          <span>{attachError}</span>
        </div>
      )}

      {followups.length > 0 && (
        <div className="followups">
          <div className="followups-label">
            <Sparkles size={12} />
            <span>下一步</span>
          </div>
          <div className="followups-row">
            {followups.map((text) => (
              <button
                key={text}
                type="button"
                className="followup-chip"
                onClick={() => fillFollowup(text)}
              >
                {text}
              </button>
            ))}
          </div>
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

      {voice.isRecording && (
        <VoiceRecordingBar
          duration={voice.duration}
          interimText={voice.interimText}
          onCancel={voice.cancel}
        />
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
          onClick={() => attachInputRef.current?.click()}
          disabled={history === null || sending}
          aria-label="添加附件"
        >
          ＋
        </button>
        <input
          ref={composerInputRef}
          placeholder={history === null ? "加载中…" : "说点什么…"}
          value={input}
          disabled={history === null || sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSubmit();
          }}
        />
        {voice.isSupported && (
          <VoiceButton
            state={voice.state}
            disabled={history === null || sending}
            onClick={voice.toggle}
          />
        )}
        {sending ? (
          <button type="button" className="stop" onClick={stop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={history === null || !input.trim()}
          >
            发送
          </button>
        )}
      </div>

      <ConversationDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpen={() => setDrawerOpen(true)}
        activeId={conversationId}
      />
    </div>
  );
}
