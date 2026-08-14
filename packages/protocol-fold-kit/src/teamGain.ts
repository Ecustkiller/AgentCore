/**
 * 回合协作计数口径 —— 只给 `message_end.collab` 换用户读得懂的说法，零新增评价。
 *
 * 用户面不渲染（状态条 / 气泡脚 / 手机团队条都不挂「互相把关」）。没有可说的就返回
 * null，调用方保持沉默。并行省时（「同时开工省下」）已否决，不在本模块。
 */

/**
 * `message_end.collab` / `MessageDetail.collab` 的结构子集（kit 不依赖事件契约包）。
 *
 * `*_by_user` 是同名计数里**用户亲手促成**的那一份（服务端按「谁做的」分出来的子集，
 * 不是另一批事件）。运营口径读的仍是总数，这里只在用户面把它减掉。
 */
export interface CollabCounts {
  boundary_yields?: number | null;
  /** `boundary_yields` 中用户在计划复核里拍板造成的那份。 */
  boundary_yields_by_user?: number | null;
  scope_signals?: number | null;
  revises?: number | null;
  /** `revises` 中用户点「立即改此人」促成的那份。 */
  revises_by_user?: number | null;
  escalations?: number | null;
}

function count(n: number | null | undefined): number {
  return typeof n === "number" && n > 0 ? n : 0;
}

/** 总数减掉用户自己促成的那份，且不会因数据错位变成负数。 */
function peerOnly(
  total: number | null | undefined,
  byUser: number | null | undefined,
): number {
  return Math.max(0, count(total) - count(byUser));
}

/** 这批计数在说的那件事：这些环节单个 AI 自己干时压根不会发生。 */
export const COLLAB_SUMMARY_TOOLTIP =
  "队伍里一个人替另一个人接住的环节：有人发现跑偏、有人被叫回重写、" +
  "有人拿不准先问过主管。都是本回合真实发生的动作计数，不是给结果打分；" +
  "你自己点的改方向和拍板不算在内。";

/**
 * 队友互相把关的一行；没有队友做的动作时返回 null（无可说则沉默）。
 *
 * 换的是说法不是数：后端计数原样用（`boundary_yields` = 中途把方向盘交出去、
 * `scope_signals` = 队员报出跑偏、`revises` = 定向唤回重写、`escalations` = 队员上报），
 * 只把「纠偏 / 漂移 / 唤回 / 上报」这套内部黑话换成用户读得懂的收益口径——同一批事实，
 * 原来的说法反而不准确：「漂移 1 次」听着像系统坏了，真相是有人跑偏、被另一个人拉回来了。
 *
 * 两处算术，都是为了不把同一件事或不属于队友的事算进来：
 *
 * 1. `escalations − scope_signals`：后端 `scope_signals` 数的是 `kind=scope` 的上报，本身
 *    就在 `escalations` 里（wave.py 从同一份 `state.escalations` 计两次）。两个数直接并列
 *    会把同一次上报数成两处，故减掉重叠，让两段互不相交。
 * 2. `− *_by_user`：这一行说的是「**队友**互相把关」，而 `revises` 里混着用户点「立即改
 *    此人」的热修、`boundary_yields` 里混着用户在计划复核上的拍板。把用户自己的操作报成
 *    队友互检，等于拿用户的动作给团队记功——他一眼就知道那次是自己点的。
 */
export function formatCollabSummary(
  collab: CollabCounts | null | undefined,
): string | null {
  if (!collab) return null;
  const scopeSignals = count(collab.scope_signals);
  const escalations = count(collab.escalations);
  const parts: string[] = [];
  if (scopeSignals > 0) parts.push(`发现跑偏 ${scopeSignals} 处`);
  const revises = peerOnly(collab.revises, collab.revises_by_user);
  if (revises > 0) parts.push(`返工重写 ${revises} 处`);
  const boundaryYields = peerOnly(
    collab.boundary_yields,
    collab.boundary_yields_by_user,
  );
  if (boundaryYields > 0) parts.push(`中途改分工 ${boundaryYields} 次`);
  const asked = Math.max(0, escalations - scopeSignals);
  if (asked > 0) parts.push(`先问再做 ${asked} 处`);
  return parts.length > 0 ? `互相把关：${parts.join(" · ")}` : null;
}
