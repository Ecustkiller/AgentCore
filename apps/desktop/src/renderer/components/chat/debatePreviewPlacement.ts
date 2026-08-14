import type { TeamPreviewDisplay } from "@/stores/conversation";

/** Gate input: captain is the CEO bookend, not a worker. Missing kind = worker. */
export type TeamGraphRun = {
  status: string;
  kind?: string | null;
};

function isWorkerRun(run: TeamGraphRun): boolean {
  return run.kind !== "captain";
}

/**
 * True once a **worker** left the never-started states (`pending`, or terminal
 * `skipped` from finalize before a start). Captain `run_started` is the CEO
 * turn itself (often emitted before `run_plan` / kickoff) and must not count —
 * live SSE drops that frame; journal hydrate restores it.
 * Hang / stop-before-start stay graph-less unless {@link shouldShowTeamGraph}
 * also sees a continue/adjust kickoff.
 * plan_review mid-wave pause (completed worker nodes exist) still shows the graph.
 */
export function teamHasStartedRuns(runs: readonly TeamGraphRun[]): boolean {
  return runs.some(
    (r) => isWorkerRun(r) && r.status !== "pending" && r.status !== "skipped",
  );
}

/** 授权并开工 / 调整后开做 — 不是取消、超时、失效. */
export function isKickoffGoDecision(
  decision: TeamPreviewDisplay["decision"] | string | null | undefined,
): boolean {
  return decision === "continue" || decision === "adjust";
}

export function isKickoffReleased(
  preview: Pick<TeamPreviewDisplay, "status" | "decision"> | null | undefined,
): boolean {
  return (
    preview?.status === "resolved" && isKickoffGoDecision(preview.decision)
  );
}

/** Still waiting on 开做 / 开赛 — a newer pending card blocks leftover go decisions. */
export function isKickoffPending(
  preview: Pick<TeamPreviewDisplay, "status" | "decision"> | null | undefined,
): boolean {
  return preview?.status === "pending";
}

/**
 * Per-message kickoff: a pending card on this bubble wins over a leaked
 * resolved continue from an earlier batch (`.some(isKickoffReleased)` alone
 * would show the graph before the new 开做).
 */
export function kickoffReleasedFromPreviews(
  previews: readonly Pick<TeamPreviewDisplay, "status" | "decision">[],
): boolean {
  if (previews.some(isKickoffPending)) return false;
  return previews.some(isKickoffReleased);
}

/** Chat / canvas / turn-detail share this: workers started or kickoff released. */
export function teamGraphVisible(
  runs: readonly TeamGraphRun[] | null | undefined,
  previews: readonly Pick<TeamPreviewDisplay, "status" | "decision">[],
): boolean {
  return shouldShowTeamGraph(runs, kickoffReleasedFromPreviews(previews));
}

/**
 * Inline graph visibility.
 * - 开工挂起（未拍板）：false，即使 run_plan 已把节点铺成 pending。
 * - captain-only running（CEO 本轮已开、工人未跑）：false，与「零 worker」同。
 * - 已授权 continue/adjust 且编制已在：true（pending 节点也画，不必等第一人开跑）。
 * - 取消 / 超时 / 失效且从未开跑：false。
 * - 已有工人开跑（含 plan_review 波间）：true，不依赖开工卡。
 */
export function shouldShowTeamGraph(
  runs: readonly TeamGraphRun[] | null | undefined,
  kickoffReleased = false,
): boolean {
  const list = runs ?? [];
  if (teamHasStartedRuns(list)) return true;
  return kickoffReleased && list.length > 0;
}

/**
 * Shared visibility for resolved team_preview content (debate or delegate):
 * when true → 图已出现则不画废卡（hide standalone ResolvedTeamPreview）；
 * when false → keep the standalone card (pending, cancel, or no plan yet).
 *
 * 藏卡与出图同一套闸：`bubblePreviews` 里只要有 pending，leftover go
 * 不得藏卡（否则同泡新卡未拍板时图也不出 → 空窗）。缺省只看本卡。
 */
export function shouldHostPreviewInGraph(
  preview: Pick<TeamPreviewDisplay, "status" | "decision"> | null | undefined,
  runs: readonly TeamGraphRun[] | null | undefined,
  bubblePreviews?: readonly Pick<TeamPreviewDisplay, "status" | "decision">[],
): boolean {
  if (!preview || preview.status !== "resolved" || !runs) return false;
  return shouldShowTeamGraph(
    runs,
    kickoffReleasedFromPreviews(bubblePreviews ?? [preview]),
  );
}
