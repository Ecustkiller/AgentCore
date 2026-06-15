import { ApiError, NetworkError, api } from "@/services/api";

/**
 * 消息 page (找人 IM) REST client — mirrors `apps/server/.../api/routes/messages.py`
 * and its Pydantic schemas (消息IM.md §三).
 *
 * The 消息 page is human↔human, a domain separate from the 对话 page's AI
 * conversations, so this is its own service with its own types. Types are hand-
 * declared per the repo's current convention (each service owns its response
 * shapes; there is no OpenAPI codegen artifact yet — a separate concern). Keep
 * field names snake_case to match the wire payload verbatim.
 */

export type ChatType = "dm" | "group" | "official";
export type ChatMemberState = "accepted" | "pending";
export type ChatSenderType = "user" | "official" | "agent";
export type MessageContentType = "text" | "image" | "file" | "system_card";
export type WhoCanDm = "anyone" | "contacts";

/** A human shown on a chat (the peer of a dm; a member of a group). */
export interface ChatParticipant {
  id: string;
  username: string;
  display_name: string;
}

/** Persisted attachment display metadata (mirrors backend `StoredAttachment`). */
export interface StoredAttachment {
  name: string;
  path: string;
  truncated: boolean;
  kind: "file" | "dir";
  workspace_path: string | null;
}

/** One row in the IM chat list (消息页左栏), plus this user's per-chat state. */
export interface ChatSummary {
  id: string;
  type: ChatType;
  title: string | null;
  avatar_url: string | null;
  /** The other human in a dm (null for group/official); drives the row name. */
  peer: ChatParticipant | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread: number;
  pinned: boolean;
  muted: boolean;
  state: ChatMemberState;
}

/** One message in a chat thread (mirrors backend `ChatMessageDetail`). */
export interface ChatMessageDetail {
  id: string;
  chat_id: string;
  /** null sender = the official/system account. */
  sender_user_id: string | null;
  sender_type: ChatSenderType;
  content: string | null;
  content_type: MessageContentType;
  attachments: StoredAttachment[];
  /** system_card deep-link payload; null otherwise. */
  payload: Record<string, unknown> | null;
  reply_to_message_id: string | null;
  created_at: string;
}

/** A discoverable user surfaced by people-search (任意搜人, exact match). */
export interface UserSearchResult {
  id: string;
  username: string;
  display_name: string;
}

/** A user this account has blocked. */
export interface BlockedUser {
  id: string;
  username: string;
  display_name: string;
}

/** This user's discoverability + who-can-DM privacy (任意搜人 护栏). */
export interface DirectorySettings {
  discoverable: boolean;
  who_can_dm: WhoCanDm;
}

interface ChatListResponse {
  data: ChatSummary[];
  total: number;
}

interface UserSearchResponse {
  data: UserSearchResult[];
  total: number;
}

interface ChatMessageListResponse {
  data: ChatMessageDetail[];
  total: number;
  page: number;
  page_size: number;
}

interface BlockListResponse {
  data: BlockedUser[];
  total: number;
}

/** A page of a chat's messages (oldest first), paging echoed back. */
export interface MessagePage {
  messages: ChatMessageDetail[];
  total: number;
  page: number;
  pageSize: number;
}

// --- People search (任意搜人) ---

/** Exact-match people-search for starting a chat (visibility filtered server-side). */
export async function searchUsers(
  query: string,
  limit = 20,
): Promise<UserSearchResult[]> {
  const res = await api.get<UserSearchResponse>(
    `/v1/messages/users/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return res.data;
}

// --- Chats ---

/** This user's chat list (recent first), with unread counts and dm peers. */
export async function listChats(): Promise<ChatSummary[]> {
  const res = await api.get<ChatListResponse>("/v1/messages/chats");
  return res.data;
}

/** Open (or reuse) a 1:1 chat with another user (by their user id). */
export async function startDm(userId: string): Promise<ChatSummary> {
  return api.post<ChatSummary>("/v1/messages/chats/dm", { user_id: userId });
}

// --- Messages ---

/** A page of a chat's messages (oldest first). */
export async function listMessages(
  chatId: string,
  page = 1,
  pageSize = 50,
): Promise<MessagePage> {
  const res = await api.get<ChatMessageListResponse>(
    `/v1/messages/chats/${chatId}/messages?page=${page}&page_size=${pageSize}`,
  );
  return {
    messages: res.data,
    total: res.total,
    page: res.page,
    pageSize: res.page_size,
  };
}

export interface SendMessageInput {
  content: string;
  /** Client-minted id for retry-safe idempotent send (server dedups). */
  clientMsgId?: string;
  replyToMessageId?: string;
}

/** Send a message into a chat the user belongs to. */
export async function sendMessage(
  chatId: string,
  input: SendMessageInput,
): Promise<ChatMessageDetail> {
  return api.post<ChatMessageDetail>(`/v1/messages/chats/${chatId}/messages`, {
    content: input.content,
    client_msg_id: input.clientMsgId,
    reply_to_message_id: input.replyToMessageId,
  });
}

/** Advance this user's read cursor (drives unread counts). */
export async function markRead(
  chatId: string,
  lastReadMessageId: string,
): Promise<void> {
  await api.post(`/v1/messages/chats/${chatId}/read`, {
    last_read_message_id: lastReadMessageId,
  });
}

// --- Directory settings (discoverability + who-can-DM) ---

export async function getDirectory(): Promise<DirectorySettings> {
  return api.get<DirectorySettings>("/v1/messages/directory");
}

export async function updateDirectory(
  patch: Partial<DirectorySettings>,
): Promise<DirectorySettings> {
  return api.patch<DirectorySettings>("/v1/messages/directory", patch);
}

// --- Blocking (任意搜人 护栏) ---

export async function listBlocks(): Promise<BlockedUser[]> {
  const res = await api.get<BlockListResponse>("/v1/messages/blocks");
  return res.data;
}

export async function blockUser(userId: string): Promise<void> {
  await api.post("/v1/messages/blocks", { user_id: userId });
}

export async function unblockUser(targetId: string): Promise<void> {
  await api.delete(`/v1/messages/blocks/${targetId}`);
}

// --- Error phrasing ---

/**
 * A user-facing zh message for a failed messaging call.
 *
 * The backend ships precise zh refusals (e.g. 对方仅允许联系人发起会话, 无法向该
 * 用户发送消息) in `{error:{message}}`, so surface that verbatim to keep wording
 * single-sourced; fall back to a status-based phrase, then a generic one. The
 * 404 default reads as "not found" rather than leaking chat existence (IDOR).
 */
export function messagingErrorMessage(
  err: unknown,
  fallback = "操作失败，请重试",
): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { error?: { message?: string } };
      if (body.error?.message) return body.error.message;
    } catch {
      /* non-JSON body — fall through to status phrasing */
    }
    switch (err.status) {
      case 429:
        return "操作过于频繁，请稍后再试";
      case 403:
        return "无法向该用户发送消息";
      case 404:
        return "用户或会话不存在";
      case 422:
        return "请求无效，请检查后重试";
      default:
        return fallback;
    }
  }
  if (err instanceof NetworkError) return "网络连接中断，请重试";
  return fallback;
}
