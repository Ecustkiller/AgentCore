/**
 * 同对话再发 · delivery（运行时三模型 · Steer/Queue）。
 * busy 默认 queue；空闲默认 steer。显式插队由 UI 轻链传入 steer。
 * 经典无 accepting 窗口时服务端回落 queue（`degraded_from=steer`）。
 */
import type { ProjectedTurn } from "@agentcore/protocol-conformance";

export type MessageDelivery = "steer" | "queue";

/**
 * 当前 live 投影是否像「协调可插」（团队 / 辩论 / 已有插话）。
 * 仅作文案/按钮标签启发式；不再驱动默认 delivery。
 */
export function isLiveInterruptible(
  projection: ProjectedTurn | null | undefined,
): boolean {
  if (!projection) return false;
  if (projection.runs.length > 0) return true;
  if (projection.debate != null) return true;
  if (projection.debateRounds.length > 0) return true;
  if (projection.userInterjections.length > 0) return true;
  return false;
}

/** 默认 delivery：busy → queue；空闲 → steer。插队由 UI 显式传入 steer。 */
export function defaultDelivery(opts?: { busy?: boolean }): MessageDelivery {
  return opts?.busy ? "queue" : "steer";
}
