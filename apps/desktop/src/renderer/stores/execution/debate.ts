import type { DebateNarrativeRound } from "@/types/events";
import type { Execution, RunNode } from "./types";

/** Fold one 逐轮叙事 update (`debate_round_started` → focus only, verdict null;
 * `debate_round` → full focus/summary/verdict/sides) into the accumulated list,
 * keyed by `round_no` (a later `debate_round` overwrites the earlier focus-only
 * entry — it carries focus too), kept ascending. Shared by the live store action and
 * the conformance fold so both ends累积 identically. */
export function upsertDebateRound(
  rounds: DebateNarrativeRound[],
  round: DebateNarrativeRound,
): DebateNarrativeRound[] {
  const idx = rounds.findIndex((r) => r.round_no === round.round_no);
  if (idx === -1) {
    return [...rounds, round].sort((a, b) => a.round_no - b.round_no);
  }
  const next = [...rounds];
  next[idx] = round;
  return next;
}

/**
 * Whether a turn is a 辩论/审查 (前端UX设计.md §四): any run carries a stance tag.
 *
 * This is the single client-side signal that differentiates a debate from an
 * ordinary parallel batch — the DAG shape and SSE are identical (守住「形状是数据
 * 不是模式」), so the strip title / node badge / graph 分列 all key off it.
 */
export function isDebate(execution: Execution): boolean {
  // 收场产物是辩论的强信号（debate_result 必带）；进行中或旧 journal 无产物时退回
  // stance 标签（辩手 run 携带）——两者任一即「这是一场辩论」。
  return (
    execution.debate != null || execution.runs.some((r) => r.stance != null)
  );
}

/**
 * The debate roster split by side (前端UX设计.md §四), in plan order. Empty lists
 * for a non-debate turn. Used by the strip title now and the「左右并排对比」next.
 */
export function debateSides(execution: Execution): {
  pro: RunNode[];
  con: RunNode[];
} {
  return {
    pro: execution.runs.filter((r) => r.stance === "pro"),
    con: execution.runs.filter((r) => r.stance === "con"),
  };
}

/** One round's 正/反 within a comparison group (真·多轮辩论, 前端UX设计.md §四).
 * `round` is the 1-based turn; 0 means the group carries no round tags (即单轮辩论). */
export interface DebateRound {
  round: number;
  pro: RunNode[];
  con: RunNode[];
}

/** One comparison group: its full 正/反 rosters plus the same runs re-bucketed by
 * `round` (升序). A single-round group yields one bucket at round 0. */
export interface DebateGroup {
  key: string;
  pro: RunNode[];
  con: RunNode[];
  rounds: DebateRound[];
}

/**
 * The debate split into comparison groups (前端UX设计.md §四), one per `group` tag
 * (an untagged stance falls into the default `""` group), in first-seen order.
 * Powers the「左右并排对比」card: a turn can hold several opposing pairs (multi-
 * dimension review), each rendered as its own 正方 vs 反方 row. Empty for非辩论.
 *
 * Each group also carries its `rounds` — the same runs re-bucketed by `round`
 * (真·多轮辩论) in ascending turn order. The card lays a multi-round group out 逐轮
 * and a single-round one (all round 0) as a flat 正/反 pair, both off this one
 * projection — no second source of truth.
 */
export function debateGroups(execution: Execution): DebateGroup[] {
  const groups: DebateGroup[] = [];
  for (const run of execution.runs) {
    if (run.stance == null) continue;
    const key = run.group ?? "";
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, pro: [], con: [], rounds: [] };
      groups.push(group);
    }
    (run.stance === "pro" ? group.pro : group.con).push(run);
    let bucket = group.rounds.find((r) => r.round === run.round);
    if (!bucket) {
      bucket = { round: run.round, pro: [], con: [] };
      group.rounds.push(bucket);
    }
    (run.stance === "pro" ? bucket.pro : bucket.con).push(run);
  }
  for (const group of groups) {
    group.rounds.sort((a, b) => a.round - b.round);
  }
  return groups;
}

/** One round of a multi-side debate (圆桌 / 红队 / 3+方) in progress: the round number
 * + that round's debater run per side. Unlike {@link DebateGroup} (正/反 stance pairs),
 * multi-side rounds have no stance to pair, so each side's run just sits in the row. */
export interface DebateLiveRound {
  round: number;
  runs: RunNode[];
}

/**
 * Multi-side debate (圆桌 / 红队 / 3+方) reconstructed into rounds for the in-progress
 * inline view — the gap {@link debateGroups} leaves (it only pairs stance-tagged 2方
 * debates, so 圆桌/红队 showed nothing inline until 收场). Under the moderator +
 * continue_run redesign a debater's round 1 is a plan-declared node (group `debate:*`,
 * no stance) and every later round is a 续写 revision of it (revision N == 第 N 轮), so
 * we walk each side's revision chain to lay the rounds out. Each cell still renders via
 * {@link RunNode}'s agent (the revision inherits the side's role + streams its own
 * output). Empty for 非辩论 / 2方正反 (handled by debateGroups) / 收场后.
 */
export function debateLiveRounds(execution: Execution): DebateLiveRound[] {
  const sides = execution.runs.filter(
    (r) => r.group?.startsWith("debate:") && r.stance == null && r.revisionOf == null,
  );
  if (sides.length === 0) return [];
  const revisionsByOriginal = new Map<string, RunNode[]>();
  for (const run of execution.runs) {
    if (run.revisionOf == null) continue;
    const list = revisionsByOriginal.get(run.revisionOf) ?? [];
    list.push(run);
    revisionsByOriginal.set(run.revisionOf, list);
  }
  let maxRound = 1;
  for (const side of sides) {
    for (const rev of revisionsByOriginal.get(side.id) ?? []) {
      maxRound = Math.max(maxRound, rev.revision);
    }
  }
  const rounds: DebateLiveRound[] = [];
  for (let r = 1; r <= maxRound; r++) {
    const runs: RunNode[] = [];
    for (const side of sides) {
      if (r === 1) {
        runs.push(side);
        continue;
      }
      const rev = (revisionsByOriginal.get(side.id) ?? []).find((x) => x.revision === r);
      if (rev) runs.push(rev);
    }
    if (runs.length > 0) rounds.push({ round: r, runs });
  }
  return rounds;
}
