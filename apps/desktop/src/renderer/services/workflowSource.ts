/**
 * 工作流的出处 —— 工作流记录顶层的服务端权威字段（不在 definition 里）。
 *
 * 它曾经写在 definition 顶层，但 definition 是画布整份覆盖的文档：用户在画布上存一次
 * 就把出处抹了，这条工作流从此不再被认成「对话固化来的」，跑一次时的按需抽槽也就不再
 * 触发。搬到独立字段后客户端既删不掉也伪造不了。
 *
 * 与 definition 相反，这里做窄映射：客户端从不把出处写回服务端，不存在「解析时丢字段
 * = 用户点一次保存就抹掉」那条风险（`deliverable` / `slots` 踩过）。
 *
 * 与 REST 客户端分开放：判据是纯函数，用到它的单测不必为此 mock 掉整个 API 模块。
 */

/** 出处快照。`kind` 由服务端判定，`turn` = 从一轮对话固化而来。 */
export interface WorkflowSource {
  kind: string;
  /** 固化那一轮所在的对话；服务端没给则 null。 */
  conversationId: string | null;
  /** 固化那一轮的那条消息；服务端没给则 null。 */
  messageId: string | null;
}

function text(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** wire（snake_case，可缺省 / 可为 null）→ 域对象；形状不对一律当「没有出处」。 */
export function parseWorkflowSource(raw: unknown): WorkflowSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const kind = text(row.kind);
  if (kind === null) return null;
  return {
    kind,
    conversationId: text(row.conversation_id),
    messageId: text(row.message_id),
  };
}

/**
 * 这条工作流是不是「一轮对话固化」来的。
 *
 * 只有这类工作流的任务文本里才有上一轮写死的值可抽；空白新建 / 官方模板复制的没有，
 * 对它们发抽槽请求只是白等。
 */
export function isWorkflowFromTurn(
  source: WorkflowSource | null | undefined,
): source is WorkflowSource {
  return source?.kind === "turn";
}

/**
 * 回到固化它的那一轮：走消息永久链接那条路（`/conversations/:id?msg=<messageId>`），
 * 对话页加载完会落到这条消息上。定位信息不全就没有可跳的地方（null）。
 */
export function workflowTurnPath(
  source: WorkflowSource | null | undefined,
): string | null {
  if (!isWorkflowFromTurn(source) || !source.conversationId) return null;
  const base = `/conversations/${source.conversationId}`;
  return source.messageId ? `${base}?msg=${source.messageId}` : base;
}
