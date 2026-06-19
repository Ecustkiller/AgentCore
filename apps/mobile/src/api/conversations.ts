// Conversation REST for the mobile client (手机端落地设计 P1 · 会话管理).
//
// Bearer-authenticated reads/writes over the same cloud endpoints the desktop uses
// (api/routes/conversations.py). Pure data fetch — the chat transport (SSE) lives in
// stream.ts. The response types are a hand-written subset of the backend schemas
// (schemas.py) covering only the fields this skeleton renders; the desktop generates the
// full set from OpenAPI (mobile has no gen pipeline yet — matches the existing skeleton
// convention in stream.ts/client.ts of typing responses inline).
import type { Citation, ProcessStep, SSEEvent } from "@agentcore/contract-types";
import { apiFetch } from "@/api/client";

export interface ConversationSummary {
  id: string;
  title: string | null;
  updated_at: string;
  created_at: string;
  message_count: number;
  pinned: boolean;
  archived: boolean;
}

/** An assistant message's persisted replay payload (schemas.py RunsPayload).
 *  `events` is a MULTI-agent turn's ordered run/tool SSE journal (empty `[]` for a
 *  single-agent turn) — re-fold it through the SAME {@link fold} as the live stream to
 *  reproduce the team graph on reload. `process` is a SINGLE-agent turn's 思考+工具
 *  timeline (verbatim ProcessStep[]; null unless a tool ran). `null` whole payload for a
 *  plain text turn. */
export interface RunsPayload {
  events: SSEEvent[];
  finish_reason: string | null;
  process: ProcessStep[] | null;
}

/** A user message's attachment as persisted (composer 附件). The agent-chat send ships the
 *  file text inline; the server durably stores it, so a reloaded turn carries only display
 *  metadata (name + truncation), not the content — enough to show context chips. */
export interface AttachmentMeta {
  name: string;
  truncated?: boolean;
}

export interface MessageDetail {
  id: string;
  role: string;
  content: string | null;
  reasoning_content: string | null;
  citations: Citation[];
  runs: RunsPayload | null;
  attachments?: AttachmentMeta[];
  created_at: string;
}

/** The latest page of the user's conversations (newest-first). `archived` selects the
 *  「已归档」view; the default live list excludes archived rows (backend default). */
export async function listConversations(
  archived = false,
): Promise<ConversationSummary[]> {
  const res = await apiFetch(
    `/v1/conversations?page=1&page_size=50&archived=${archived}`,
  );
  if (!res.ok) throw new Error(`加载会话列表失败 (${res.status})`);
  const data = (await res.json()) as { data: ConversationSummary[] };
  return data.data;
}

/** Rename a conversation (对话管理 · 重命名). Returns the updated summary. */
export async function renameConversation(
  id: string,
  title: string,
): Promise<ConversationSummary> {
  const res = await apiFetch(`/v1/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`重命名失败 (${res.status})`);
  return (await res.json()) as ConversationSummary;
}

/** Archive (hide from the live list) or restore a conversation — reversible, no data
 *  loss (对话管理 · 归档/恢复). */
export async function setConversationArchived(
  id: string,
  archived: boolean,
): Promise<void> {
  const res = await apiFetch(`/v1/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) {
    throw new Error(`${archived ? "归档" : "恢复"}失败 (${res.status})`);
  }
}

/** Permanently delete a conversation and its messages (对话管理 · 删除). */
export async function deleteConversation(id: string): Promise<void> {
  const res = await apiFetch(`/v1/conversations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`删除失败 (${res.status})`);
}

/** Create a fresh cloud conversation and return its id (skeleton: no folder/mode). */
export async function createConversation(title?: string): Promise<string> {
  const res = await apiFetch("/v1/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title ?? null }),
  });
  if (!res.ok) throw new Error(`创建会话失败 (${res.status})`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

/** A window of messages plus whether older ones exist (drives 加载更早). */
export interface MessageWindow {
  messages: MessageDetail[];
  hasMoreBefore: boolean;
}

/** The latest window of a conversation's messages (chronological, oldest-first), or —
 *  with `before` (an ISO cursor) — the page strictly older than it (scroll-up). The
 *  endpoint windows at ≤200; we load 100 at a time and use `has_more_before` to know
 *  whether to keep paging back. */
export async function getMessages(
  conversationId: string,
  before?: string,
): Promise<MessageWindow> {
  const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/messages?limit=100${cursor}`,
  );
  if (!res.ok) throw new Error(`加载消息失败 (${res.status})`);
  const data = (await res.json()) as {
    data: MessageDetail[];
    has_more_before: boolean;
  };
  return { messages: data.data, hasMoreBefore: data.has_more_before };
}
