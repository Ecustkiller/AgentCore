import { api } from "@/services/api";
import {
  type Message,
  checkpointsFromEvents,
  planReviewsFromEvents,
  useConversationStore,
} from "@/stores/conversation";
import type { components } from "@/types/api.generated";
import type { ProcessStep, SSEEvent } from "@/types/events";

type Schemas = components["schemas"];
/** A window of messages (cursor-windowed, oldest-first) from the REST endpoint. */
type BackendMessageListResponse = Schemas["MessageListResponse"];

/**
 * A persisted message as the REST endpoint shapes it. Mirrors the generated
 * `MessageDetail`, but types `runs.events` as the client's {@link SSEEvent}
 * union (the OpenAPI carries it as opaque JSON — SSE/event payloads are exempt
 * from the generated-types rule, API 开发规范) so the team-graph replay fold is
 * typed end to end.
 */
export interface BackendMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  reasoning_content: string | null;
  attachments?: {
    name: string;
    path: string;
    truncated: boolean;
    kind?: "file" | "dir";
    workspace_path?: string | null;
  }[];
  citations?: {
    url: string;
    title: string;
    snippet?: string;
    site?: string;
  }[];
  /** Persisted turn replay payload. `events` is a multi-agent turn's ordered
   * run/tool SSE events (replayed through the same fold as the live stream to
   * rebuild the team graph on reload, §9.3); `process` is a single-agent turn's
   * 思考+工具 timeline (前端UX设计.md §一). null for user / plain turns. (Opaque JSON
   * in the OpenAPI — SSE/event payloads are exempt from the generated-types rule.) */
  runs?: {
    events: SSEEvent[];
    finish_reason: string | null;
    process?: ProcessStep[] | null;
  } | null;
  created_at: string;
}

/** A loaded slice of a conversation, plus the flags that drive infinite scroll. */
export interface MessageWindow {
  messages: Message[];
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

/** The execution (plan) id of a reloaded multi-agent turn — the first
 * `run_plan`'s id in the persisted journal. null for user / single-agent turns
 * (no journal, or a journal with no plan), which then render as plain bubbles. */
function executionIdOf(events: SSEEvent[]): string | null {
  const plan = events.find((e) => e.type === "run_plan");
  const id = (plan?.payload as { execution_id?: string } | undefined)
    ?.execution_id;
  return id ?? null;
}

/** Map a persisted message row to the client's domain {@link Message}, rebuilding
 * its team graph / checkpoint projections from the journal so a reloaded turn
 * renders exactly like its live one did. */
export function toMessage(m: BackendMessage): Message {
  const events = m.runs?.events ?? [];
  const executionId = executionIdOf(events);
  // Checkpoints are journaled even on single-agent turns (no run_plan), so parse
  // them independently of `executionId` — a turn can have a checkpoint without a
  // team graph.
  const checkpoints = checkpointsFromEvents(events);
  // plan_review events are journaled like ask_user checkpoints, so a reloaded turn
  // replays its structured DAG pauses inline too (结构化挂起 2a).
  const planReviews = planReviewsFromEvents(events);
  // Single-agent 思考+工具 process timeline (前端UX设计.md §一): prefer the persisted
  // ordered steps (a tool-using turn), else synthesize one reasoning step from
  // reasoning_content (a thinking-only turn, or a pre-feature row), so the inline
  // process panel replays the shape the live turn built. Multi-agent turns omit it
  // — the team graph carries their activity instead.
  const process: ProcessStep[] | undefined = executionId
    ? undefined
    : (m.runs?.process ??
      (m.reasoning_content
        ? [{ kind: "reasoning", text: m.reasoning_content }]
        : undefined));
  return {
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content ?? "",
    reasoning: m.reasoning_content ?? undefined,
    process,
    createdAt: m.created_at,
    // Stamp the plan id so the bubble renders its inline team graph; the journal
    // below lets that graph replay the turn (both null for non-team turns).
    executionId,
    runs: executionId
      ? { events, finishReason: m.runs?.finish_reason ?? "stop" }
      : undefined,
    checkpoints: checkpoints.length ? checkpoints : undefined,
    planReviews: planReviews.length ? planReviews : undefined,
    isStreaming: false,
    attachments: m.attachments?.length
      ? m.attachments.map((a) => ({
          id: crypto.randomUUID(),
          name: a.name,
          path: a.path,
          truncated: a.truncated,
          kind: a.kind ?? "file",
          workspacePath: a.workspace_path ?? undefined,
        }))
      : undefined,
    citations: m.citations?.length ? m.citations : undefined,
  };
}

/** How to window a conversation's messages — mutually exclusive (the backend
 * checks `around` → `before` → `after` → latest in that order). */
export interface MessageWindowQuery {
  /** Center the window on this message id (search-hit jump, load-around B). */
  around?: string;
  /** Load the page strictly older than this ISO cursor (scroll up). */
  before?: string;
  /** Load the page strictly newer than this ISO cursor (scroll down). */
  after?: string;
  /** Page size per direction (default = backend default of 100). */
  limit?: number;
}

/**
 * Fetch one window of a conversation's messages.
 *
 * No params → the latest window (conversation open). `around`/`before`/`after`
 * drive the search-hit jump and infinite scroll. The returned `hasMore*` flags
 * tell the caller whether more remain in each direction.
 */
export async function fetchMessageWindow(
  conversationId: string,
  query: MessageWindowQuery = {},
): Promise<MessageWindow> {
  const params = new URLSearchParams();
  if (query.around) params.set("around", query.around);
  if (query.before) params.set("before", query.before);
  if (query.after) params.set("after", query.after);
  if (query.limit != null) params.set("limit", String(query.limit));
  const qs = params.toString();
  const res = await api.get<BackendMessageListResponse>(
    `/v1/conversations/${conversationId}/messages${qs ? `?${qs}` : ""}`,
  );
  return {
    messages: res.data.map((m) => toMessage(m as unknown as BackendMessage)),
    total: res.total,
    hasMoreBefore: res.has_more_before,
    hasMoreAfter: res.has_more_after,
  };
}

/** ISO `createdAt` of a conversation slice's oldest / newest loaded message, or
 * null when empty. The cursors infinite scroll pages from. */
function edgeCursors(conversationId: string): {
  oldest: string | null;
  newest: string | null;
} {
  const slice = useConversationStore.getState().byId[conversationId]?.messages;
  if (!slice || slice.length === 0) return { oldest: null, newest: null };
  return {
    oldest: slice[0].createdAt,
    newest: slice[slice.length - 1].createdAt,
  };
}

/**
 * Load the page just older than what's loaded and prepend it (scroll up).
 * No-op when nothing more remains or a load is already in flight, so a burst of
 * scroll events collapses into one request.
 */
export async function loadOlderMessages(conversationId: string): Promise<void> {
  const store = useConversationStore.getState();
  const rt = store.byId[conversationId];
  if (!rt || !rt.hasMoreBefore || rt.loadingOlder) return;
  const { oldest } = edgeCursors(conversationId);
  if (!oldest) return;
  store.setLoadingOlder(true, conversationId);
  try {
    const win = await fetchMessageWindow(conversationId, { before: oldest });
    useConversationStore
      .getState()
      .prependMessages(win.messages, win.hasMoreBefore, conversationId);
  } catch {
    /* best-effort: a failed page just leaves the older button to retry on scroll */
  } finally {
    useConversationStore.getState().setLoadingOlder(false, conversationId);
  }
}

/**
 * Load the page just newer than what's loaded and append it (scroll down).
 * Only meaningful after a load-around jump left newer history unloaded
 * (`hasMoreAfter`); a no-op at the live head.
 */
export async function loadNewerMessages(conversationId: string): Promise<void> {
  const store = useConversationStore.getState();
  const rt = store.byId[conversationId];
  if (!rt || !rt.hasMoreAfter || rt.loadingNewer) return;
  const { newest } = edgeCursors(conversationId);
  if (!newest) return;
  store.setLoadingNewer(true, conversationId);
  try {
    const win = await fetchMessageWindow(conversationId, { after: newest });
    useConversationStore
      .getState()
      .appendNewerMessages(win.messages, win.hasMoreAfter, conversationId);
  } catch {
    /* best-effort */
  } finally {
    useConversationStore.getState().setLoadingNewer(false, conversationId);
  }
}

/**
 * Reload the latest window, replacing whatever is on screen. Used to snap back
 * to the live head before a new turn when the user is reading a historical
 * window (a search-hit jump left `hasMoreAfter`), so the turn appends at the
 * true tail rather than into a mid-conversation gap.
 */
export async function loadLatestWindow(conversationId: string): Promise<void> {
  const win = await fetchMessageWindow(conversationId);
  useConversationStore
    .getState()
    .setMessageWindow(
      win.messages,
      { hasMoreBefore: win.hasMoreBefore, hasMoreAfter: win.hasMoreAfter },
      conversationId,
    );
}

/**
 * Jump the conversation to a specific message (search-hit "命中必达").
 *
 * If the message is already in the loaded window, just scroll/flash it. Otherwise
 * fetch a window centered on it (load-around B), swap it in, then focus — so a hit
 * outside the latest 100 still lands precisely. Assumes `conversationId` is (or is
 * becoming) the active conversation; the caller navigates there first.
 */
export async function jumpToMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const store = useConversationStore.getState();
  const rt = store.byId[conversationId];
  const present = rt?.messages.some((m) => m.id === messageId);
  if (present) {
    store.focusMessage(messageId);
    return;
  }
  try {
    const win = await fetchMessageWindow(conversationId, { around: messageId });
    const after = useConversationStore.getState();
    // The user may have navigated away while the window loaded — only swap it in
    // if this conversation is still the one on screen.
    if ((after.currentConversationId ?? "") !== conversationId) return;
    after.setMessageWindow(
      win.messages,
      { hasMoreBefore: win.hasMoreBefore, hasMoreAfter: win.hasMoreAfter },
      conversationId,
    );
    // Focus on the next frame so the bubbles have rendered before we scroll.
    requestAnimationFrame(() =>
      useConversationStore.getState().focusMessage(messageId),
    );
  } catch {
    /* message gone / not owned — leave the conversation as-is */
  }
}

/**
 * Delete a single message (单条消息删除). Removes the row server-side, then drops
 * it from the conversation's live window. Server-first so a failed delete leaves
 * the message on screen; throws on failure so the caller can surface a toast.
 * Append-only cost ledger is untouched server-side (real spend is never rewritten).
 */
export async function deleteMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  await api.delete(`/v1/conversations/${conversationId}/messages/${messageId}`);
  useConversationStore.getState().removeMessage(messageId, conversationId);
}
