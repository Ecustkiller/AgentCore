/**
 * 对话级订阅（云对话多端同权 B2）的折叠决策——纯函数，便于用例锁住「不得同回合双折叠」。
 *
 * 一条订阅连接跨多个回合：`[回合重放…] : attach-caught-up [实时帧…]`，回合收口后回到心跳等
 * 下一个回合。传输层无从提前分段（新回合的重放段先于它自己的边界注释到达），所以切分只能按
 * `message_start` 的 `message_id`——同 id 永远是同一个气泡（挂起恢复照契约重开同 id）。
 *
 * 「什么时候清」不由本端推断：全量重放段的段首 `message_start` 带 `full_replay`，收到即无条件
 * 重置该回合已折的帧再整段重折。重放段为空时（回合在本端订阅归位之后才起跑）新回合的
 * `message_start` 直接落在边界注释之后、不带标记——那一段没有东西要抹。
 */

import type { MessageStartPayload } from "@agentcore/contract-types";

/** 段首读数（非 `message_start` 帧没有段首）。 */
export interface SegmentHead {
  /** 该段的云 `message_id`；服务端没给时为空串。 */
  messageId: string;
  /** 服务端明令：这一段是全量重放，折之前先重置该回合的本地流式状态。 */
  fullReplay: boolean;
}

/** 读一帧的段首信息；非 `message_start` 帧返回 `null`（同段续帧，不做切分判断）。 */
export function readSegmentHead(event: {
  type: string;
  payload?: unknown;
}): SegmentHead | null {
  if (event.type !== "message_start") return null;
  const payload = (event.payload ?? {}) as MessageStartPayload;
  return {
    messageId: payload.message_id ? String(payload.message_id) : "",
    fullReplay: payload.full_replay === true,
  };
}

/** 订阅当前跟播到哪个回合、折进哪个气泡。 */
export interface FollowTurnCursor {
  /** 该段的云 `message_id`；段首帧不是 `message_start` 时先留空，之后补盖。 */
  messageId: string | null;
  /** 折进哪个气泡。 */
  turnId: string;
}

/** 本端已有的 live 气泡（只看 events 判身份）。 */
export interface FoldedTurnLike {
  id: string;
  events: readonly { type: string; payload?: unknown }[];
}

export interface FollowSegmentPlan {
  cursor: FollowTurnCursor;
  /**
   * - `continue` 同段继续（含段首补盖 id）
   * - `open` 本端还没有这个回合的气泡 → 新开
   * - `reset` 服务端明令的全量重放 → 认领既有气泡并**先清空**，再整段重折
   * - `adopt` 直播段首落在既有气泡上（挂起恢复重开同 id）→ 直接续折，没有重放要抹
   */
  action: "continue" | "open" | "reset" | "adopt";
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

function findFoldedId(
  turns: readonly FoldedTurnLike[],
  messageId: string,
): string | null {
  for (const t of turns) {
    if (turnMessageId(t.events) === messageId) return t.id;
  }
  return null;
}

/**
 * 这个 `message_id` 该折进哪个既有气泡；`null` = 本端还没有它的气泡。
 *
 * 游标优先于回查 `turns`：`turns` 是渲染快照，一串帧连着来时它可能还没追上刚折进去的
 * `message_start`，回查会误判成「本端没有这个回合」再开一个空气泡。
 */
function claimTurn(params: {
  cursor: FollowTurnCursor | null;
  messageId: string;
  adoptTurnId: string | null;
  turns: readonly FoldedTurnLike[];
}): string | null {
  const { cursor, messageId, adoptTurnId, turns } = params;
  if (cursor !== null && messageId && cursor.messageId === messageId) {
    return cursor.turnId;
  }
  // 认领姿势只对本连接的首段有效；连接内的下一个回合一定是新回合。
  if (cursor === null && adoptTurnId) return adoptTurnId;
  return messageId ? findFoldedId(turns, messageId) : null;
}

/**
 * 决定这一帧该折进哪个气泡、折之前要不要清。
 *
 * `adoptTurnId` = 本端摆出的「续看」姿势（断线重连 / 回前台 / 重开）：本连接的首段属于那个
 * 已在场的气泡，别另开——重连后气泡刚被清空、`message_start` 还没回来，回查 `turns` 认不出它。
 */
export function planFollowSegment(params: {
  cursor: FollowTurnCursor | null;
  /** 本帧的段首读数；非 `message_start` 帧传 `null`。 */
  head: SegmentHead | null;
  adoptTurnId: string | null;
  turns: readonly FoldedTurnLike[];
  newTurnId: () => string;
}): FollowSegmentPlan {
  const { cursor, head, adoptTurnId, turns, newTurnId } = params;
  const messageId = head?.messageId ?? "";
  const fullReplay = head?.fullReplay === true;
  // 带标记的段首永远另起一段：游标已停在同一回合也照清（挂起恢复会在同一条连接上用同一个
  // message_id 再开一段全量重放，续折上去就是把这个回合折两遍）。
  if (cursor !== null && !fullReplay) {
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
  const claim = claimTurn({ cursor, messageId, adoptTurnId, turns });
  const turnId = claim ?? newTurnId();
  const action = claim === null ? "open" : fullReplay ? "reset" : "adopt";
  return { cursor: { messageId: messageId || null, turnId }, action };
}

/** 订阅报「连上来时没有回合在跑」时该做什么。 */
export type FollowIdlePlan =
  /** 常态：停在空闲对话上，什么都不动。 */
  | { kind: "none" }
  /** 本端在等的回合在我们连上之前就收口了：撤掉等不到终态的空转气泡 + 回读终稿。 */
  | { kind: "settle"; staleTurnId: string | null }
  /** 重连补账：只回读消息窗，不动任何 live 气泡。 */
  | { kind: "reconcile" };

/**
 * 空闲信号的处置。
 *
 * 断线期间另一端整跑完的回合，服务端一帧都不会补发——它只重放**仍在跑**的 run，收口的那个
 * 只在 REST 窗里。所以重连挂上、且确认此刻没东西可重放时，必须补一次消息窗对账，否则那个
 * 回合在本端永远不出现（要等用户切走再切回）。
 *
 * `localStreamActive`：本端自发流正持有主时间线时不插手——整窗回读会和它折的回合打架。
 */
export function planFollowIdle(state: {
  expectLiveRun: boolean;
  adoptTurnId: string | null;
  reconnected: boolean;
  localStreamActive: boolean;
}): FollowIdlePlan {
  if (state.expectLiveRun) {
    return { kind: "settle", staleTurnId: state.adoptTurnId };
  }
  if (state.reconnected && !state.localStreamActive) {
    return { kind: "reconcile" };
  }
  return { kind: "none" };
}
