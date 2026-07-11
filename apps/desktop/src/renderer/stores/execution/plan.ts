import type { RunPlanPayload } from "@/types/events";
import type { ExecutionPlan } from "./types";

/** Map a `run_plan` wire payload to the immutable plan skeleton. */
export function planFromRunPlan(p: RunPlanPayload): ExecutionPlan {
  return {
    id: p.execution_id,
    planType: p.plan_type,
    taskSummary: p.task_summary,
    agents: p.agents.map((a) => ({
      id: a.id,
      role: a.role,
      modelPreference: a.model_preference,
      thinking: a.thinking,
      reasoningEffort: a.reasoning_effort,
    })),
    runs: p.runs.map((s) => ({
      id: s.id,
      agentId: s.agent_id,
      task: s.task,
      dependsOn: s.depends_on,
      parentRunId: s.parent_run_id ?? null,
      kind: s.kind,
      stance: s.stance,
      group: s.group,
      round: s.round,
      replacesRunId: s.replaces_run_id ?? null,
      // Presentation-only: first run_plan of a turn is 委派 #1. Not on the wire —
      // stamped here so merge / journal replay can tell later same-turn batches apart.
      delegateBatch: 1,
    })),
  };
}

/** Ensure every run has an explicit 1-based `delegateBatch` (default 1). */
export function ensureDelegateBatchStamps(plan: ExecutionPlan): ExecutionPlan {
  if (plan.runs.every((r) => r.delegateBatch != null)) return plan;
  return {
    ...plan,
    runs: plan.runs.map((r) => ({
      ...r,
      delegateBatch: r.delegateBatch ?? 1,
    })),
  };
}

/** Merge a later same-turn delegate batch into the current plan: append unseen
 * agents/runs (ids are namespaced per delegate call), keep the first batch's
 * task summary unless the new one is non-empty. Shared by {@link ingestPlan}
 * (live) and journal replay (history).
 *
 * New runs get `delegateBatch = max(existing)+1` so the collaboration graph can
 * band「第 N 次委派」without inventing depends_on edges or changing the wire. */
export function mergePlanInto(
  cur: ExecutionPlan,
  next: ExecutionPlan,
): ExecutionPlan {
  const agents = [...cur.agents];
  for (const a of next.agents) {
    if (!agents.some((x) => x.id === a.id)) agents.push(a);
  }
  const normalized = ensureDelegateBatchStamps(cur);
  let maxBatch = 0;
  for (const r of normalized.runs) {
    const b = r.delegateBatch ?? 1;
    if (b > maxBatch) maxBatch = b;
  }
  const nextBatch = maxBatch + 1;
  const runs = [...normalized.runs];
  for (const s of next.runs) {
    if (!runs.some((x) => x.id === s.id)) {
      runs.push({ ...s, delegateBatch: nextBatch });
    }
  }
  return {
    ...normalized,
    agents,
    runs,
    taskSummary: next.taskSummary || normalized.taskSummary,
  };
}
