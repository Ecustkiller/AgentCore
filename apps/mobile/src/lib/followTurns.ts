/**
 * 对话级订阅（云对话多端同权 B2）的回合切分决策——纯函数，便于用例锁住「不得同回合双折叠」。
 *
 * 一条订阅连接跨多个回合：`[回合重放…] : attach-caught-up [实时帧…]`，回合收口后回到心跳等
 * 下一个回合。传输层无从提前分段（新回合的重放段先于它自己的边界注释到达），所以切分只能按
 * `message_start` 的 `message_id`——同 id 永远是同一个气泡（挂起恢复照契约重开同 id）。
 */

/** 订阅当前跟播到哪个回合、折进哪个气泡。 */
export interface FollowTurnCursor {
  /** 该段的云 `message_id`；段首帧不是 `message_start` 时先留空，之后补盖。 */
  messageId: string | null;
  /** 折进哪个气泡；`null` = 本端已折完这个回合，这一段是多余重放，丢弃。 */
  turnId: string | null;
}

/** 本端已有的 live 气泡（只看 events 判身份与是否收口）。 */
export interface FoldedTurnLike {
  id: string;
  events: readonly { type: string; payload?: unknown }[];
}

export interface FollowSegmentPlan {
  cursor: FollowTurnCursor;
  /**
   * - `continue` 同段继续（含段首补盖 id）
   * - `open` 另一端起的新回合 → 新开气泡
   * - `adopt` 认领既有气泡续折 → **必须先清空**（重放给的是整段，不清就是折两遍）
   * - `mute` 已整段折完的多余重放 → 丢弃到下一个 `message_id`
   */
  action: "continue" | "open" | "adopt" | "mute";
}

/** Live / journal 都以 `message_start.message_id` 为准（气泡 id 是本地 UUID，不能当云 id）。 */
export function turnMessageId(events: FoldedTurnLike["events"]): string | null {
  for (const e of events) {
    if (e.type !== "message_start") continue;
    const id = (e.payload as { message_id?: string } | undefined)?.message_id;
    return id ? String(id) : null;
  }
  return null;
}

function findFolded(
  turns: readonly FoldedTurnLike[],
  messageId: string,
): { turnId: string; settled: boolean } | null {
  for (const t of turns) {
    if (turnMessageId(t.events) !== messageId) continue;
    return {
      turnId: t.id,
      settled: t.events.some((e) => e.type === "message_end"),
    };
  }
  return null;
}

/**
 * 决定这一帧该折进哪个气泡。
 *
 * `adoptTurnId` = 本端摆出的「续看」姿势（断线重连 / 回前台 / 重开）：本连接的首段属于那个
 * 已在场的气泡，别另开。没有姿势时按 `message_id` 反查本端是否已折过同一回合——订阅归位时
 * 服务端可能还挂着刚收口的 run 并整段重放，那一段折完的该丢、没折完的该认领。
 */
export function planFollowSegment(params: {
  cursor: FollowTurnCursor | null;
  /** 本帧的 `message_id`；非 `message_start` 帧传空串。 */
  messageId: string;
  adoptTurnId: string | null;
  turns: readonly FoldedTurnLike[];
  newTurnId: () => string;
}): FollowSegmentPlan {
  const { cursor, messageId, adoptTurnId, turns, newTurnId } = params;
  if (cursor !== null) {
    // 段首帧不是 message_start（预检警告 / 出队帧先到）——此刻补盖 id，气泡不变。
    if (messageId && cursor.messageId === null) {
      return {
        cursor: { messageId, turnId: cursor.turnId },
        action: "continue",
      };
    }
    if (messageId === "" || cursor.messageId === messageId) {
      return { cursor, action: "continue" };
    }
  }
  const folded = messageId ? findFolded(turns, messageId) : null;
  if (folded?.settled) {
    return { cursor: { messageId, turnId: null }, action: "mute" };
  }
  // 认领姿势只对本连接的首段有效；连接内的下一个回合一定是新回合。
  const adopt = cursor === null ? adoptTurnId : null;
  const claim = adopt ?? folded?.turnId ?? null;
  const turnId = claim ?? newTurnId();
  return {
    cursor: { messageId: messageId || null, turnId },
    action: claim === null ? "open" : "adopt",
  };
}
