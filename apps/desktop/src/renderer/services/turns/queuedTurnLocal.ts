import {
  mapQueuedAttachments,
  mapQueuedMentions,
} from "@/services/queuedTurnMap";
import { hasLocalConversationStream } from "@/services/turns/streamOwnership";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import {
  type QueuedTurnEntry,
  useQueuedTurnsStore,
} from "@/stores/queuedTurns";

/**
 * ``turn_saved``：把服务端用户行 id 记到还没有 id 的排队条上。
 * 不改时间线。已是这个 id、或本会话没有未绑定的条 → 调用方不得再
 * ``reconcileLastTurn``（会改掉上一轮最后一条 user）。
 */
export function bindQueuedTurnUserId(
  conversationId: string,
  userMessageId: string,
): boolean {
  const serverId = userMessageId.trim();
  if (!serverId) return false;
  const queued = useQueuedTurnsStore.getState();
  const list = queued.list(conversationId);
  if (list.some((entry) => entry.messageId === serverId)) return true;
  const unbound = [...list].reverse().find((entry) => !entry.messageId);
  if (!unbound) return false;
  queued.upsert({ ...unbound, messageId: serverId });
  return true;
}

/**
 * 按稳定 id 放入时间线，窗里已有则不动。
 * 排队出队帧和插话被接住时共用。
 */
export function insertUserRowOnce(
  conversationId: string,
  row: {
    id: string;
    content: string;
    attachments?: readonly { name: string; workspacePath?: string }[];
    agentMentions?: readonly { agentId: string; role: string }[];
  },
): string | null {
  const id = row.id.trim();
  if (!id) return null;
  const messages = getRuntime(conversationId).messages;
  if (messages.some((m) => m.id === id || m.serverMessageId === id)) return id;
  const attachments = row.attachments?.filter((a) => a.name.trim()) ?? [];
  const agentMentions =
    row.agentMentions?.filter((a) => a.agentId.trim() && a.role.trim()) ?? [];
  if (!row.content && attachments.length === 0 && agentMentions.length === 0) {
    return null;
  }
  useConversationStore.getState().addMessage(
    {
      id,
      role: "user",
      content: row.content,
      createdAt: new Date().toISOString(),
      executionId: null,
      isStreaming: false,
      attachments:
        attachments.length > 0
          ? attachments.map((a, i) => ({
              id: `caught-att-${i}`,
              name: a.name.trim(),
              path: a.workspacePath?.trim() || a.name.trim(),
              truncated: false,
              workspacePath: a.workspacePath,
            }))
          : undefined,
      agentMentions:
        agentMentions.length > 0
          ? agentMentions.map((a) => ({
              agentId: a.agentId.trim(),
              role: a.role.trim(),
            }))
          : undefined,
    },
    conversationId,
  );
  return id;
}

/**
 * 段首点名之后，这条用户行不再回到排队条上。
 * 快照只知道「id 不在队里」，分不清出队、取消和重启；点名是出队的正面证据。
 */
const promotedUserMessageIds = new Map<string, Set<string>>();

export function rememberPromotedUserRow(
  conversationId: string,
  userMessageId: string,
): void {
  const id = userMessageId.trim();
  if (!conversationId || !id) return;
  let set = promotedUserMessageIds.get(conversationId);
  if (!set) {
    set = new Set();
    promotedUserMessageIds.set(conversationId, set);
  }
  set.add(id);
}

export function isPromotedUserRow(
  conversationId: string,
  userMessageId: string | undefined,
): boolean {
  const id = userMessageId?.trim();
  if (!id) return false;
  return promotedUserMessageIds.get(conversationId)?.has(id) ?? false;
}

export function resetPromotedUserRowsForTests(): void {
  promotedUserMessageIds.clear();
}

/** 点名之后按用户行 id 摘掉排队条，并记住该 id，后来的快照不得放回。 */
export function releaseNamedQueueEntry(
  conversationId: string,
  userMessageId: string,
): void {
  rememberPromotedUserRow(conversationId, userMessageId);
  const queued = useQueuedTurnsStore.getState();
  for (const entry of [...queued.list(conversationId)]) {
    if (entry.messageId === userMessageId) {
      queued.remove(conversationId, entry.queueId);
    }
  }
}

/**
 * 出队开跑：按 ``user_message_id`` 把用户行放进时间线。
 * ``turn_queue_started`` 与点名的 ``message_start`` 共用。窗里已有同一 id 则不动。
 * 没有稳定 id 时不造一条临时泡（刷新会和落库行叠成两条）。
 * ``beforeMessageId`` 把新行插到该助手泡之前，避免用户行变成尾部、吃掉 ``content_delta``。
 */
export function insertQueuedTurnUserBubble(
  conversationId: string,
  payload: unknown,
  opts?: { beforeMessageId?: string },
): string | null {
  const p =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const queueId = typeof p.queue_id === "string" ? p.queue_id.trim() : "";
  const fromFrame =
    typeof p.user_message_id === "string" ? p.user_message_id.trim() : "";
  const queued = queueId
    ? useQueuedTurnsStore
        .getState()
        .list(conversationId)
        .find((entry) => entry.queueId === queueId)
    : undefined;
  const id = fromFrame || queued?.messageId || "";
  if (!id) return null;

  const messages = getRuntime(conversationId).messages;
  if (messages.some((m) => m.id === id || m.serverMessageId === id)) return id;

  const hasContentField = typeof p.content === "string";
  const content = hasContentField
    ? (p.content as string)
    : (queued?.content ?? "");
  const attachments =
    mapQueuedAttachments(p.attachments) ?? queued?.attachments;
  const agentMentions =
    mapQueuedMentions(p.agent_mentions) ?? queued?.agentMentions;
  if (!hasContentField && !content && !attachments && !agentMentions) {
    return null;
  }

  const message = {
    id,
    role: "user" as const,
    content,
    createdAt: new Date().toISOString(),
    executionId: null,
    isStreaming: false,
    attachments:
      attachments && attachments.length > 0
        ? attachments.map((a, i) => ({
            id: `mf-att-${i}`,
            name: a.name,
            path: a.path,
            truncated: a.truncated,
            kind: a.kind,
            conversationId: a.conversation_id,
            documentId: a.document_id,
            workspacePath: a.workspace_path,
          }))
        : undefined,
    agentMentions:
      agentMentions && agentMentions.length > 0
        ? agentMentions.map((a) => ({
            agentId: a.agent_id,
            role: a.role,
          }))
        : undefined,
  };
  const beforeId = opts?.beforeMessageId?.trim();
  if (beforeId) {
    useConversationStore
      .getState()
      .insertMessageBefore(message, beforeId, conversationId);
  } else {
    useConversationStore.getState().addMessage(message, conversationId);
  }
  return id;
}

/**
 * 本地清排队条（幂等）。
 * ``dropBubble`` 缺省为真：确认取消删对应已在列表里的用户行。
 * 已开跑（404 / ``not_found``）传 false：只清条，行留给正在跑的回合。
 */
export function clearQueuedTurnLocally(
  conversationId: string,
  queueId: string,
  opts?: { dropBubble?: boolean },
): QueuedTurnEntry | null {
  const removed = useQueuedTurnsStore
    .getState()
    .remove(conversationId, queueId);
  if (opts?.dropBubble !== false && removed?.messageId) {
    useConversationStore
      .getState()
      .removeMessage(removed.messageId, conversationId);
  }
  return removed;
}

/**
 * 快照里某个用户行 id 离开了队列，而时间线还没有这一行。
 * 本端正占着这条对话的发送流时不补（出队帧会按 id 插入）。
 * 其余情况用消息窗把落库行补上。
 */
export function backfillUserRowsLeftQueue(
  conversationId: string,
  previous: readonly { queueId?: string; messageId?: string }[],
  next: readonly { queueId?: string; messageId?: string }[],
): void {
  const stillIds = new Set(
    next
      .map((entry) => entry.messageId)
      .filter((id): id is string => Boolean(id)),
  );
  const stillQueues = new Set(
    next
      .map((entry) => entry.queueId)
      .filter((id): id is string => Boolean(id)),
  );
  const messages = getRuntime(conversationId).messages;
  const missing = previous.some((entry) => {
    const id = entry.messageId;
    if (!id || stillIds.has(id)) return false;
    // 同一条还在队里，只是 id 被快照纠正：继续留在排队条上，不补时间线。
    if (entry.queueId && stillQueues.has(entry.queueId)) return false;
    return !messages.some((m) => m.id === id || m.serverMessageId === id);
  });
  if (!missing || hasLocalConversationStream(conversationId)) return;
  void import("@/services/messages").then(({ loadLatestWindow }) =>
    loadLatestWindow(conversationId, { softRefresh: true }),
  );
}
