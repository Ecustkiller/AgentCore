import { notifyInfo } from "@/lib/toast";
import { BASE_URL, notifyUnauthorized, tryRefresh } from "@/services/api";
import { toMemoryUpdate } from "@/services/messages";
import type { ChatMessageDetail } from "@/services/messaging";
import { applyConversationPromotion } from "@/services/workspacePromotion";
import { useConversationStore } from "@/stores/conversation";
import { useMessagingStore } from "@/stores/messaging";

/**
 * Per-user realtime firehose client for the 消息 page (消息IM.md §四).
 *
 * One long-lived `GET /v1/realtime` SSE stream carries every chat's new messages
 * to this user (server→client; sending stays POST). It runs at the app shell for
 * the whole authenticated session — not the 消息 page — so unread badges and
 * incoming messages update even while the user is on the 对话 page.
 *
 * The same per-user firehose also carries `workspace_promoted` (跨端实时同步): a 裸聊
 * promoted on ANY surface (the turn's first write, a panel write, or "打开本地文件夹")
 * re-groups the chat + surfaces its workspace card on this device too — the turn SSE /
 * REST response only reaches the surface that drove the promotion, so without this a
 * second device leaves the chat stranded in 未分组 until a refetch.
 *
 * SSE can't refresh a token mid-stream, so this mirrors the POST stream's policy
 * (streamConversation.ts): on a 401, refresh once and reconnect; otherwise drop
 * to login. Transport drops reconnect with capped exponential backoff, and every
 * (re)connect triggers a catch-up (refetch the chat list + reload the open
 * thread) so anything missed while disconnected is re-synced (离线补偿).
 */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let running = false;
let controller: AbortController | null = null;
let reconnectTimer: number | null = null;
let attempts = 0;

type StreamOutcome = "reconnect" | "stop";

interface ChatMessageEvent {
  type: "chat_message";
  chat_id: string;
  message: ChatMessageDetail;
}

interface WorkspacePromotedEvent {
  type: "workspace_promoted";
  conversation_id: string;
  folder_id: string;
  name: string;
  local_root_id: string | null;
  local_subpath: string;
}

/** 记忆更新对话内可见 (§1.6): one offline-consolidation pass that changed a memory
 * file. `update` (the conversation-tail card payload) is present whenever the pass
 * recorded a row; its shape mirrors the REST `MemoryUpdateView` so {@link toMemoryUpdate}
 * maps it. Absent on older/edge passes — then we fall back to the heads-up toast. */
interface MemoryUpdatedEvent {
  type: "memory_updated";
  conversation_id: string;
  update?: {
    id: string;
    created_at: string;
    items?: {
      action: string;
      file: string;
      section: string;
      scope: string;
      content: string;
      target: string;
    }[];
  };
}

/** Re-sync state that may have changed while disconnected. */
function catchUp(): void {
  const store = useMessagingStore.getState();
  void store.fetchChats();
  if (store.activeChatId) void store.loadMessages(store.activeChatId);
}

/** Parse one SSE frame (lines split by \n) and dispatch a chat_message. */
function handleFrame(frame: string): void {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return; // heartbeat comment or event-only frame
  try {
    const event = JSON.parse(dataLines.join("\n")) as { type?: string };
    if (event.type === "chat_message") {
      const e = event as ChatMessageEvent;
      useMessagingStore.getState().applyIncoming(e.chat_id, e.message);
    } else if (event.type === "workspace_promoted") {
      // A 裸聊 promoted on another surface — re-group it + surface its card here too,
      // via the same client-side sink the turn SSE / panel promote use (no drift).
      const e = event as WorkspacePromotedEvent;
      applyConversationPromotion(e.conversation_id, {
        id: e.folder_id,
        name: e.name,
        localDir: null,
        localRootId: e.local_root_id,
        localSubpath: e.local_subpath,
      });
    } else if (event.type === "memory_updated") {
      // The offline consolidation pass refreshed the user's long-term memory (off the
      // turn path). 记忆更新对话内可见 (§1.6): live-append the「记忆已更新」card to the
      // conversation it came from (no-op if that conversation isn't loaded — it fetches
      // the card itself on next open).
      const e = event as MemoryUpdatedEvent;
      const conv = useConversationStore.getState();
      if (e.update && e.conversation_id) {
        conv.addMemoryUpdate(toMemoryUpdate(e.update), e.conversation_id);
      }
      // When the user is looking at that very conversation the inline card IS the signal,
      // so skip the toast; otherwise a heads-up so another surface (e.g. an open「AI 记忆」
      // editor) knows to reload.
      const cardShown =
        !!(e.update && e.conversation_id) &&
        conv.currentConversationId === e.conversation_id;
      if (!cardShown) {
        notifyInfo("AI 刚刚更新了你的记忆");
      }
    }
    // "ready" and any other event types: no-op here.
  } catch {
    /* malformed frame — skip */
  }
}

/** Open the stream and pump frames until it ends; returns how to proceed. */
async function runStream(signal: AbortSignal): Promise<StreamOutcome> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/v1/realtime`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/event-stream" },
      signal,
    });
  } catch {
    return "reconnect"; // transport failure (offline / aborted)
  }

  if (response.status === 401) {
    if (await tryRefresh()) return "reconnect";
    notifyUnauthorized();
    return "stop";
  }
  if (!response.ok || !response.body) return "reconnect";

  // Connected: reset backoff and re-sync anything missed while disconnected.
  attempts = 0;
  catchUp();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) handleFrame(frame);
    }
  } catch {
    return "reconnect"; // read error (incl. abort — caller checks the signal)
  }
  return "reconnect"; // server closed the stream
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer !== null) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  attempts += 1;
  reconnectTimer = window.setTimeout(
    () => {
      reconnectTimer = null;
      void connect();
    },
    delay + Math.random() * 500,
  );
}

async function connect(): Promise<void> {
  if (!running) return;
  const ac = new AbortController();
  controller = ac;
  let outcome: StreamOutcome = "reconnect";
  try {
    outcome = await runStream(ac.signal);
  } catch {
    outcome = "reconnect";
  }
  if (ac.signal.aborted || !running) return;
  if (outcome === "stop") {
    running = false;
    return;
  }
  scheduleReconnect();
}

/** Open the firehose for the current session (idempotent). */
export function startRealtime(): void {
  if (running) return;
  running = true;
  attempts = 0;
  void connect();
}

/** Close the firehose and cancel any pending reconnect (idempotent). */
export function stopRealtime(): void {
  running = false;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  controller?.abort();
  controller = null;
}
