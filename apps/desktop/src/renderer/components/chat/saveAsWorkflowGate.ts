/**
 * 「把这轮协作存成工作流」的显示闸（前端UX设计.md §三 完成态条）。
 *
 * 工作流的主入口是「刚跑完一轮满意的协作」那一刻，不是工具箱里从零画 DAG。
 * 所以入口只挂完成态：单队员 / 纯对话回合没有可复用的分工，硬停回合也不是
 * 「满意的一轮」——两者都不出按钮（服务端对非多队员回合同样 422）。
 *
 * 辩论环节同理，但判据不同：服务端固化的是 `plan_snapshot` fact，那只有 delegate
 * 路径写，辩论席位（主持人 / 辩手 / 证人）从不进快照。所以人头只数 delegate 那半——
 * 纯辩论回合数出 0 不出按钮（否则点下去必 422），混合回合（既派了单又打了辩论）
 * 仍按 delegate 队员数照常出，服务端能存下那半并在降级说明里交代辩论不在快照内。
 */
import { resolveDebateModeratorRunId } from "@/components/chat/detail/debateModerator";
import { type Execution, isDebateTaggedRun } from "@/stores/execution";

/** 少于这个人数就不成「团队分工」，快照没有复用价值。 */
export const MIN_WORKFLOW_TEAM_MEMBERS = 2;

/**
 * 归辩论环节所有、因而不进计划快照的 run。
 *
 * 三条来源合并：带辩论标记的辩手 / 证人（{@link isDebateTaggedRun}）、主持人本人，
 * 以及主持人名下整棵子树——庭前附属 run 未必带标记，但同样是辩论开的场子。
 */
function debateOwnedRunIds(
  execution: Pick<Execution, "runs" | "debate">,
): Set<string> {
  const owned = new Set<string>();
  for (const run of execution.runs) {
    if (isDebateTaggedRun(run)) owned.add(run.id);
  }
  const moderatorId = resolveDebateModeratorRunId(execution);
  if (moderatorId != null) owned.add(moderatorId);
  if (owned.size === 0) return owned;
  let grew = true;
  while (grew) {
    grew = false;
    for (const run of execution.runs) {
      if (owned.has(run.id) || run.parentRunId == null) continue;
      if (!owned.has(run.parentRunId)) continue;
      owned.add(run.id);
      grew = true;
    }
  }
  return owned;
}

/**
 * 本回合真正上过场、且固化得进画布的队员数。
 *
 * captain 是 CEO 汇聚点不是队员；同人接续（续派 / 热修 / 辩论质询结辩）是同一个人的
 * 第 N 次发言，不另计人头；cascade-skip 的节点从未开跑；辩论席位不落计划快照，
 * 服务端固化不到，这里也不算人头（{@link debateOwnedRunIds}）。
 */
export function turnTeamMemberCount(
  execution: Pick<Execution, "runs" | "debate">,
): number {
  const debateOwned = debateOwnedRunIds(execution);
  return execution.runs.filter(
    (r) =>
      r.kind === "agent" &&
      r.continuesRunId == null &&
      r.status !== "skipped" &&
      r.status !== "pending" &&
      !debateOwned.has(r.id),
  ).length;
}

/** 这轮能否存成工作流（完成态 + 多队员协作）。 */
export function canSaveTurnAsWorkflow(
  execution: Pick<Execution, "runs" | "status" | "debate">,
): boolean {
  if (execution.status !== "completed") return false;
  return turnTeamMemberCount(execution) >= MIN_WORKFLOW_TEAM_MEMBERS;
}

/**
 * 降级口径兜底文案。服务端在 workflow summary 的 `description` 里带本轮的降级说明
 * （与「官方模板复制」同口径），有就照原样显示；缺失时至少说清快照的边界，
 * 不能让用户以为复跑 == 原样重演。
 */
export const WORKFLOW_SNAPSHOT_DEGRADE_NOTE =
  "快照只带走「谁做什么、先后依赖、交付要求」。本轮的模型选择、辩论站位等运行细节不进快照，复跑效果可能与原轮不同。";
