import type { DebateNarrativeRound } from "@/types/events";
import type { DebateRoundDecision, Execution, RunNode } from "./types";

/** A folded update to the 交互式逐轮辩论 decision list: a `debate_round_decision_required`
 * (`required` → append a `pending` card) or its `debate_round_decision_resolved` (`resolved` →
 * settle the matching card by `id`). The SSE handler builds one from each event; {@link
 * foldDebateDecision} applies it. */
export type DebateDecisionUpdate =
  | {
      kind: "required";
      id: string;
      moderatorRunId: string;
      roundNo: number;
      focus: string;
      summary: string;
      converged: boolean;
      rationale: string;
    }
  | {
      kind: "resolved";
      id: string;
      decision: "continue" | "conclude" | "timeout";
      focus: string;
    };

/** 结算事件的 `decision` → 决策卡 `status`：continue→continued / conclude→concluded /
 * timeout→timeout（未应答或无活跃用户，裁判自动收敛接管）。 */
const DECISION_TO_STATUS: Record<
  "continue" | "conclude" | "timeout",
  DebateRoundDecision["status"]
> = {
  continue: "continued",
  conclude: "concluded",
  timeout: "timeout",
};

/**
 * Fold one {@link DebateDecisionUpdate} into the decision list (desktop-live-only; the
 * conformance ProjectedTurn never carries these). `required` appends a `pending` card (or
 * replaces one with the same `id`, defensively); `resolved` settles the matching card by `id`
 * — a resolve for an unknown id is ignored (stale / already gone). Insertion order is kept
 * (rounds arrive ascending), so the view renders them top-to-bottom as they happened.
 */
export function foldDebateDecision(
  decisions: DebateRoundDecision[],
  update: DebateDecisionUpdate,
): DebateRoundDecision[] {
  if (update.kind === "required") {
    const card: DebateRoundDecision = {
      id: update.id,
      moderatorRunId: update.moderatorRunId,
      roundNo: update.roundNo,
      focus: update.focus,
      summary: update.summary,
      converged: update.converged,
      rationale: update.rationale,
      status: "pending",
      decisionFocus: "",
    };
    const idx = decisions.findIndex((d) => d.id === update.id);
    if (idx === -1) return [...decisions, card];
    const next = [...decisions];
    next[idx] = card;
    return next;
  }
  const idx = decisions.findIndex((d) => d.id === update.id);
  if (idx === -1) return decisions;
  const next = [...decisions];
  next[idx] = {
    ...next[idx],
    status: DECISION_TO_STATUS[update.decision],
    decisionFocus: update.decision === "continue" ? update.focus : "",
  };
  return next;
}

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
 * 辩论 continue_run 的发言角色（阶段化 beat）：与 `run_context.channel` 对齐——
 * `cross_exam` / `closing` 已在 wire；陈词续轮无专属 channel，归 `statement`。
 * 协作图角标 / 侧栏轮次轨据此区分「第 N 轮」与「第 N 轮·质询」/「结辩」，避免同轮双列同文。
 */
export type DebateBeat = "statement" | "cross_exam" | "closing";

/** 从 `run_context` blocks 读 beat（复用既有 channel，不新造 wire 字段）。 */
export function debateBeatFromContext(
  blocks: ReadonlyArray<{ channel: string }> | null | undefined,
): DebateBeat {
  if (!blocks?.length) return "statement";
  if (blocks.some((b) => b.channel === "closing")) return "closing";
  if (blocks.some((b) => b.channel === "cross_exam")) return "cross_exam";
  return "statement";
}

/**
 * 辩论续写节点可见文案：首轮陈词无角标（由调用方跳过）；续轮陈词「第 N 轮」；
 * 质询「第 N 轮·质询」；结辩「结辩」（不挂轮次，避免与末轮陈词撞文）。
 */
export function debateBeatLabel(opts: {
  round?: number;
  revision?: number;
  beat?: DebateBeat | null;
}): string {
  const beat = opts.beat ?? "statement";
  if (beat === "closing") return "结辩";
  const n = opts.round && opts.round > 0 ? opts.round : (opts.revision ?? 0);
  if (beat === "cross_exam") return `第 ${n} 轮·质询`;
  return `第 ${n} 轮`;
}

/**
 * Whether a turn is a 辩论/审查 (前端UX设计.md §四).
 *
 * This is the single client-side signal that differentiates a debate from an
 * ordinary parallel batch — the DAG shape and SSE are identical (守住「形状是数据
 * 不是模式」), so the strip title / node badge / graph 分列 / 放大态「交锋」页 all key
 * off it.
 */
export function isDebate(execution: Execution): boolean {
  // 收场产物是辩论的强信号（debate_result 必带）。进行中无产物时退回辩手 run 的标签：
  // 2 方正反带 stance；多方圆桌/红队无 stance，靠 `group=debate:*`（与 {@link
  // debateLiveRounds} / liveForm 同一权威信号）——否则进行中的圆桌会被漏判为普通并行批，
  // 「交锋」页与对话式直播都不出现。三者任一即「这是一场辩论」。
  return (
    execution.debate != null ||
    execution.runs.some(
      (r) => r.stance != null || r.group?.startsWith("debate:"),
    )
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
 * no stance) and every later round is a 续写 revision of it, so we walk each side's
 * revision chain and bucket by the revision's {@link RunNode.round} (乙 wire 携
 * round/stance · 单一轮次投影) — the SAME `round` field debateGroups reads.
 * renders via {@link RunNode}'s agent (the revision inherits the side's role + streams
 * its own output). Empty for 非辩论 / 2方正反 (handled by debateGroups) / 收场后.
 */
export function debateLiveRounds(execution: Execution): DebateLiveRound[] {
  const sides = execution.runs.filter(
    (r) =>
      r.group?.startsWith("debate:") &&
      r.stance == null &&
      r.revisionOf == null,
  );
  if (sides.length === 0) return [];
  const revisionsByOriginal = new Map<string, RunNode[]>();
  for (const run of execution.runs) {
    if (run.revisionOf == null) continue;
    const list = revisionsByOriginal.get(run.revisionOf) ?? [];
    list.push(run);
    revisionsByOriginal.set(run.revisionOf, list);
  }
  // 单一轮次投影: round 只读 wire 字段（无 round 时为 0）。
  const roundOf = (r: RunNode): number => r.round ?? 0;
  let maxRound = 1;
  for (const side of sides) {
    for (const rev of revisionsByOriginal.get(side.id) ?? []) {
      maxRound = Math.max(maxRound, roundOf(rev));
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
      const rev = (revisionsByOriginal.get(side.id) ?? []).find(
        (x) => roundOf(x) === r,
      );
      if (rev) runs.push(rev);
    }
    if (runs.length > 0) rounds.push({ round: r, runs });
  }
  return rounds;
}
