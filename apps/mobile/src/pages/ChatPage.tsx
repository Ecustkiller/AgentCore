import { getTokens } from "@/api/client";
import {
  type MessageDetail,
  createConversation,
  getMessages,
} from "@/api/conversations";
import { attachStream, resumeStream, streamMessage } from "@/api/stream";
import {
  type PausedTurnSummary,
  listPausedTurns,
  stopConversation,
} from "@/api/turn";
import { getMessageCostTotal } from "@/api/usage";
import { AssistantContent } from "@/components/AssistantView";
import { ConversationDrawer } from "@/components/ConversationDrawer";
import { PauseCard } from "@/components/PauseCard";
import { ResumeCard } from "@/components/ResumeCard";
import { type MessageAttachment, readTextAttachment } from "@/lib/attachments";
import { fold } from "@/protocol/fold";
import type { CheckpointDecision, SSEEvent } from "@agentcore/contract-types";
import type { ProjectedTurn } from "@agentcore/protocol-conformance";
import { Folder, Menu, SquarePen } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** One-line status derived from the projected turn — proves the fold drives the UI
 * (进度 / 工具 are read off ProjectedTurn, not re-parsed from events). A `paused` turn
 * returns null: the interactive PauseCard above the composer owns that surface. */
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

function AssistantBubble({ turn, live }: { turn: Turn; live: boolean }) {
  const p = useMemo(() => fold(turn.events), [turn.events]);
  const meta = summarize(p);
  const isMulti = p.runs.length > 0;
  const team = isMulti
    ? { agents: p.agents, runs: p.runs, progress: p.progress }
    : undefined;
  const empty =
    !isMulti && p.process.length === 0 && !p.content && !p.reasoning;
  // 回合总账 — populated by message_end (null while streaming, so it appears on finish).
  const cost = formatCost(p.cost?.total);
  return (
    <div className="bubble assistant">
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
        />
      )}
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
function HistoryAssistant({ m }: { m: MessageDetail }) {
  const { team, debate } = useMemo(() => {
    const events = m.runs?.events;
    if (!events || events.length === 0)
      return { team: undefined, debate: null };
    const p = fold(events);
    const team =
      p.runs.length > 0
        ? { agents: p.agents, runs: p.runs, progress: p.progress }
        : undefined;
    return { team, debate: p.debate };
  }, [m.runs]);
  const process = m.runs?.process ?? undefined;
  // A persisted message carries no cost; lazy-fetch it from the ledger when seen.
  const { ref, total } = useLazyMessageCost(m.id);
  const cost = formatCost(total);

  if (
    !team &&
    (!process || process.length === 0) &&
    !m.content &&
    !m.reasoning_content &&
    m.citations.length === 0
  ) {
    return null;
  }
  return (
    <div className="bubble assistant" ref={ref}>
      <AssistantContent
        process={process}
        content={m.content ?? ""}
        reasoning={m.reasoning_content ?? undefined}
        citations={m.citations}
        captainContext={m.runs?.captain_context ?? undefined}
        team={team}
        debate={debate}
      />
      {cost && <div className="cost">{cost}</div>}
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
  // Turns that paused at a checkpoint then lost their stream (durable resume frames),
  // surfaced as ResumeCards on reopen (结构化挂起 2b).
  const [paused, setPaused] = useState<PausedTurnSummary[]>([]);
  // Older messages exist above the loaded window (drives 加载更早); `loadingOlder` blocks
  // re-entrancy while a page is in flight (历史上翻分页).
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set just before an older page is prepended: the viewport's distance-from-bottom to
  // restore afterwards, so the content under the user's eyes doesn't jump (scroll anchor).
  const prependAnchorRef = useRef<number | null>(null);
  // The controller for the stream currently held open (send / reattach). 停止 aborts it.
  const abortRef = useRef<AbortController | null>(null);

  // Append an event to the live (last) turn — lazily opening a userText-less turn when
  // none exists yet (a reattach on reopen, whose user bubble is already in history).
  const appendEvent = (event: SSEEvent) =>
    setTurns((t) => {
      if (t.length === 0) {
        return [{ id: crypto.randomUUID(), userText: null, events: [event] }];
      }
      const next = t.slice();
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, event] };
      return next;
    });

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
      return;
    }
    setHistory(null);
    setTurns([]);
    setError(null);
    setSending(false);
    setPaused([]);
    setHasMoreBefore(false);
    let cancelled = false;
    // Best-effort: a turn that paused at a checkpoint then lost its stream surfaces as a
    // resume card. Never blocks opening the conversation (it stays recoverable on reopen).
    listPausedTurns(conversationId)
      .then((p) => {
        if (!cancelled) setPaused(p);
      })
      .catch(() => {});
    getMessages(conversationId)
      .then(({ messages, hasMoreBefore: more }) => {
        if (cancelled) return;
        setHistory(messages);
        setHasMoreBefore(more);
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
          void attachOnOpen(conversationId);
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

  // Keep the view pinned to the bottom for new/streamed content, EXCEPT right after an
  // older page is prepended: then restore the prior distance-from-bottom so the messages
  // under the user's eyes stay put (useLayoutEffect → before paint, no visible jump).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every `turns`/`history` change to re-pin/restore scroll; the body reads refs, not these values
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependAnchorRef.current != null) {
      el.scrollTop = el.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = null;
    } else {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [turns, history]);

  // Page strictly older messages in above the window (历史上翻分页). The oldest loaded
  // row's created_at is the cursor; we anchor the viewport (distance-from-bottom) so the
  // prepend doesn't yank the scroll. Re-entrancy-guarded; the chat keeps working if it fails.
  async function loadOlder() {
    if (!conversationId || loadingOlder || !hasMoreBefore) return;
    const oldest = history?.[0];
    if (!oldest) return;
    const el = scrollRef.current;
    prependAnchorRef.current = el ? el.scrollHeight - el.scrollTop : 0;
    setLoadingOlder(true);
    try {
      const { messages, hasMoreBefore: more } = await getMessages(
        conversationId,
        oldest.created_at,
      );
      setHistory((h) => [...messages, ...(h ?? [])]);
      setHasMoreBefore(more);
    } catch (e) {
      prependAnchorRef.current = null;
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
  const pending = sending ? (liveProjection?.pendingInteraction ?? null) : null;

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
        {history?.map((m) => {
          if (m.role !== "user") return <HistoryAssistant key={m.id} m={m} />;
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
            />
          </div>
        ))}
      </div>

      {pending && conversationId && (
        <PauseCard
          key={
            pending.kind === "approval"
              ? pending.approvalId
              : pending.checkpointId
          }
          pending={pending}
          conversationId={conversationId}
          runs={liveProjection?.runs ?? []}
        />
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
          placeholder={history === null ? "加载中…" : "说点什么…"}
          value={input}
          disabled={history === null || sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSubmit();
          }}
        />
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
