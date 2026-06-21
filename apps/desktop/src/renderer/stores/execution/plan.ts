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
    })),
  };
}

/** Merge a later same-turn delegate batch into the current plan: append unseen
 * agents/runs (ids are namespaced per delegate call), keep the first batch's
 * task summary unless the new one is non-empty. Shared by {@link ingestPlan}
 * (live) and journal replay (history). */
export function mergePlanInto(
  cur: ExecutionPlan,
  next: ExecutionPlan,
): ExecutionPlan {
  const agents = [...cur.agents];
  for (const a of next.agents) {
    if (!agents.some((x) => x.id === a.id)) agents.push(a);
  }
  const runs = [...cur.runs];
  for (const s of next.runs) {
    if (!runs.some((x) => x.id === s.id)) runs.push(s);
  }
  return {
    ...cur,
    agents,
    runs,
    taskSummary: next.taskSummary || cur.taskSummary,
  };
}
