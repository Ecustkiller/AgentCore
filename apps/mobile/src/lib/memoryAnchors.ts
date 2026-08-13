/**
 * 「记忆已更新 / 已记下本场摘要」卡在消息流里的落点——纯函数，便于用例锁住锚定规则。
 *
 * 离线固化是回合收口之后异步跑的：卡的 `createdAt` 只说明「什么时候固化的」，不说明「总结
 * 了哪一段」。按它排，卡永远比所有消息都晚，多张就全堆在页面最底部。后端为此另给 `anchorAt`
 * = 本次固化窗口最后一条消息的 created_at；按锚点把卡插到「下一条更晚的用户消息之前」，即
 * 它所总结那一轮的末尾——用户提问才是回合边界，助手回复属于它上面那一轮，所以卡不会夹进
 * 问答对中间（Agent记忆与知识系统 §1.6）。语义 / 配额卡没有固化窗口（`anchorAt` 为空）→ 退回
 * `createdAt`，通常落在末尾。
 */

/** 锚定只关心「谁是回合边界」：用户消息，按落库时间。 */
export interface AnchorableMessage {
  id: string;
  role: string;
  created_at: string;
}

/** 一次固化结果的锚定字段（`MemoryUpdate` 的结构子集）。 */
export interface AnchorableUpdate {
  anchorAt?: string | null;
  createdAt: string;
}

export interface MemoryUpdatePlacement<T> {
  /** 消息 id → 插在这条消息之前的卡（锚点升序）。 */
  before: Map<string, T[]>;
  /** 后面已没有更晚用户消息可锚的卡：留在消息流末尾（live 回合之后）。 */
  tail: T[];
}

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** 卡的锚定时刻：固化窗口末尾，缺失（语义 / 配额卡）时退回固化时刻。 */
export function memoryAnchorMs(update: AnchorableUpdate): number {
  return toMs(update.anchorAt ?? update.createdAt);
}

/**
 * 把记忆卡分配到各回合末尾。`messages` 按时间正序（服务端窗口即此序）。
 *
 * 锚点严格早于某条用户消息 → 插在它之前；锚点与边界同刻说明那条消息本身就在固化窗口内，
 * 归下一个边界。没有更晚的用户消息 → 落末尾。
 */
export function placeMemoryUpdates<T extends AnchorableUpdate>(
  messages: readonly AnchorableMessage[],
  updates: readonly T[],
): MemoryUpdatePlacement<T> {
  const before = new Map<string, T[]>();
  const tail: T[] = [];
  if (updates.length === 0) return { before, tail };

  const anchored = updates
    .map((update) => ({ update, at: memoryAnchorMs(update) }))
    .sort((a, b) => a.at - b.at);

  let next = 0;
  for (const m of messages) {
    if (next >= anchored.length) break;
    if (m.role !== "user") continue;
    const boundary = toMs(m.created_at);
    const bucket: T[] = [];
    while (next < anchored.length && anchored[next].at < boundary) {
      bucket.push(anchored[next++].update);
    }
    if (bucket.length > 0) before.set(m.id, bucket);
  }
  for (; next < anchored.length; next++) tail.push(anchored[next].update);

  return { before, tail };
}
