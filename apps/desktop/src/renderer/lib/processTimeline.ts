// 单聊 process timeline 的纯 fold helpers（思考·正文·工具内联时间线，前端UX设计.md §一B）。
//
// 生产实时渲染（stores/conversation.ts 经 foldMessageLane）与跨端协议巡检
// （protocol/conformanceFold.ts）共用 processTimeline + foldMessageLane 纯函数——
// live 流、reload 回放、conformance golden 读到同一形状。
//
// 不可变：每个 append* 返回新 process 数组；resolveToolStep 在无匹配时返回原引用，便于
// store 做 no-op 短路。

import type {
  ProcessStep,
  ToolPhase,
  ToolUseEndPayload,
  ToolUseProgressPayload,
  ToolUseStartPayload,
} from "@/types/events";

/**
 * Fold one reasoning delta into the timeline: extend the trailing reasoning step
 * when the last step is thinking, else open a new one. Coalescing consecutive
 * deltas keeps the timeline a few segments (one per think→act boundary) rather
 * than one node per token.
 */
export function appendReasoningStep(
  process: ProcessStep[] | undefined,
  delta: string,
): ProcessStep[] {
  const steps = process ? [...process] : [];
  const last = steps[steps.length - 1];
  if (last && last.kind === "reasoning") {
    steps[steps.length - 1] = { ...last, text: last.text + delta };
  } else {
    steps.push({ kind: "reasoning", text: delta });
  }
  return steps;
}

/**
 * Fold one content delta into the timeline: extend the trailing content step when
 * the last step is reply text, else open a new one. The trailing content step is
 * the final answer — the timeline IS the reply (前端UX设计.md §一B).
 */
export function appendContentStep(
  process: ProcessStep[] | undefined,
  delta: string,
): ProcessStep[] {
  const steps = process ? [...process] : [];
  const last = steps[steps.length - 1];
  if (last && last.kind === "content") {
    steps[steps.length - 1] = { ...last, text: last.text + delta };
  } else {
    steps.push({ kind: "content", text: delta });
  }
  return steps;
}

/**
 * Drop the trailing content step(s) from the timeline (交付前核验回炉 content_reset):
 * the model's done-round draft failed the light verification (e.g. fabricated
 * citations), so its just-streamed reply text is discarded and rewritten. Mirrors the
 * backend `EventSink._accumulate_process` reset branch — pop ONLY trailing `content`
 * steps, keeping the preceding reasoning / tool steps (they really happened). Returns
 * the same reference when there is nothing to drop so callers can no-op.
 */
export function dropTrailingContentSteps(
  process: ProcessStep[] | undefined,
): ProcessStep[] {
  if (!process || process.length === 0) return process ?? [];
  if (process[process.length - 1].kind !== "content") return process;
  const steps = [...process];
  while (steps.length > 0 && steps[steps.length - 1].kind === "content") {
    steps.pop();
  }
  return steps;
}

/** Append a started tool call as a `running` step to the timeline.
 *
 * Skipped (returns the same reference so callers can no-op) for:
 * - a DELEGATED WORKER's call (`payload.run_id` set): workers share the turn's top-level
 *   tool_use stream, but their calls belong to their run node, not the captain bubble's
 *   inline timeline (统一团队时间线 = the CEO's OWN steps);
 * - an ORCHESTRATION call (delegate/debate): the `team` marker (dropped at `run_plan`)
 *   stands in its place as the collaboration graph's slot, so it makes no tool step.
 *   Mirrors the backend `EventSink._accumulate_process`. */
export function appendToolStep(
  process: ProcessStep[] | undefined,
  payload: ToolUseStartPayload,
): ProcessStep[] {
  if (payload.run_id || isOrchestrationTool(payload.tool_name))
    return process ?? [];
  const steps = process ? [...process] : [];
  steps.push({
    kind: "tool",
    id: payload.tool_call_id,
    tool_name: payload.tool_name,
    arguments: payload.arguments ?? {},
    result: null,
    status: "running",
  });
  return steps;
}

/**
 * Resolve a tool step (result + status) on its matching `tool_use_end`; returns the
 * same array reference when no step matches (id absent) so callers can no-op.
 *
 * `display` is written ONLY when the payload carries one — a value-less display
 * leaves the field ABSENT (not null), matching the backend oracle's golden +
 * EventSink (无富渲染 → 字段不出现). The renderer treats absent/null identically
 * (ToolResultView gates on `if (d.display)`), so production loses nothing.
 */
export function resolveToolStep(
  process: ProcessStep[] | undefined,
  payload: ToolUseEndPayload,
): ProcessStep[] | undefined {
  // A worker's / orchestration call never entered the captain timeline (see
  // appendToolStep) — no-op.
  if (payload.run_id || isOrchestrationTool(payload.tool_name)) return process;
  if (!process) return process;
  let changed = false;
  const steps = process.map((s) => {
    if (!changed && s.kind === "tool" && s.id === payload.tool_call_id) {
      changed = true;
      const resolved = { ...s, result: payload.result, status: payload.status };
      if (payload.display != null) resolved.display = payload.display;
      return resolved;
    }
    return s;
  });
  return changed ? steps : process;
}

/**
 * 工具执行阶段进度 (联网搜索前端展示优化): stamp a RUNNING tool step's latest coarse `phase`
 * from a `tool_use_progress` event (web_search → queued / querying / fallback), driving the
 * waiting-state text so the user sees a live, honest state instead of a bare spinner.
 *
 * LIVE-ONLY: this event never rides a journal / conformance vector, so it is folded ONLY on the
 * production stream (conformanceFold never calls this) — the golden's tool steps stay phase-less
 * and the optional `phase` field keeps every ProjectedTurn byte-identical. Writes ONLY while the
 * step is still `running` (a late phase racing after `tool_use_end` is ignored) and only for the
 * captain's OWN calls (a worker / orchestration call never entered this timeline — see
 * {@link appendToolStep}). Returns the same reference when nothing matched so callers no-op.
 */
export function resolveToolStepPhase(
  process: ProcessStep[] | undefined,
  payload: ToolUseProgressPayload,
): ProcessStep[] | undefined {
  if (payload.run_id || isOrchestrationTool(payload.tool_name)) return process;
  if (!process) return process;
  let changed = false;
  const steps = process.map((s) => {
    if (
      !changed &&
      s.kind === "tool" &&
      s.id === payload.tool_call_id &&
      s.status === "running"
    ) {
      changed = true;
      // Wire `phase` is a widened string (forward-compat); the UI maps known ToolPhase
      // values to text and falls back to a generic label for anything else.
      return { ...s, phase: payload.phase as ToolPhase };
    }
    return s;
  });
  return changed ? steps : process;
}

/** Whether a positional marker step of `kind` keyed by `key`==`value` is already in the
 * timeline — keeps a replayed / multi-batch event from dropping a duplicate anchor. */
function hasMarker(
  process: ProcessStep[] | undefined,
  kind: ProcessStep["kind"],
  key: string,
  value: string,
): boolean {
  return !!process?.some(
    (s) => s.kind === kind && (s as Record<string, unknown>)[key] === value,
  );
}

/** Drop a `team` marker (collaboration graph slot) at the turn's FIRST `run_plan`
 * (统一团队时间线): later same-execution batches merge into one graph, so only one marker
 * per execution. Returns the same reference when already present so callers can no-op.
 * Mirrors the backend `EventSink._accumulate_process`. */
export function appendTeamStep(
  process: ProcessStep[] | undefined,
  executionId: string,
): ProcessStep[] {
  if (!executionId) return process ?? [];
  if (hasMarker(process, "team", "execution_id", executionId))
    return process ?? [];
  return [...(process ?? []), { kind: "team", execution_id: executionId }];
}

/** Drop a `checkpoint` marker (blocking ask_user) at its chronological spot; the card
 * body folds separately, keyed by `checkpointId`. No-op (same ref) if already present. */
export function appendCheckpointStep(
  process: ProcessStep[] | undefined,
  checkpointId: string,
): ProcessStep[] {
  if (!checkpointId) return process ?? [];
  if (hasMarker(process, "checkpoint", "checkpoint_id", checkpointId))
    return process ?? [];
  return [
    ...(process ?? []),
    { kind: "checkpoint", checkpoint_id: checkpointId },
  ];
}

/** Drop an `ask` marker (non-blocking question) at its chronological spot; the card body
 * folds separately, keyed by `askId`. No-op (same ref) if already present. */
export function appendAskStep(
  process: ProcessStep[] | undefined,
  askId: string,
): ProcessStep[] {
  if (!askId) return process ?? [];
  if (hasMarker(process, "ask", "ask_id", askId)) return process ?? [];
  return [...(process ?? []), { kind: "ask", ask_id: askId }];
}

/** Drop a `plan_review` marker (plan-review gate) at its chronological spot; the card
 * body folds separately, keyed by `checkpointId`. No-op (same ref) if already present. */
export function appendPlanReviewStep(
  process: ProcessStep[] | undefined,
  checkpointId: string,
): ProcessStep[] {
  if (!checkpointId) return process ?? [];
  if (hasMarker(process, "plan_review", "checkpoint_id", checkpointId))
    return process ?? [];
  return [
    ...(process ?? []),
    { kind: "plan_review", checkpoint_id: checkpointId },
  ];
}

/** A tool step (narrowed from {@link ProcessStep}). */
export type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

/**
 * A render node for the inline timeline after consecutive tool steps are coalesced
 * (前端UX设计.md §一B). `reasoning` / `content` and the positional markers (`team` /
 * `checkpoint` / `ask` / `plan_review`) stay 1:1 with their steps — they are the
 * natural boundaries that break a tool run → 保序; a maximal run of ≥2 adjacent tool
 * steps folds into one collapsible `tool-group`; a lone tool stays inline as `tool`
 * (阈值 ≥2 — 单个不套壳，维持现状平铺).
 */
export type TimelineNode =
  | Exclude<ProcessStep, { kind: "tool" }>
  | { kind: "tool"; step: ToolStep }
  | { kind: "tool-group"; tools: ToolStep[] };

/** Tools that hand the turn off to a sub-team and open a team execution: `delegate`
 * (emits `run_plan` type=multi_agent) and `debate`. A multi-agent bubble renders its
 * inline team graph AT this step's position in the timeline (统一团队时间线), so
 * {@link groupToolRuns} keeps such a step an un-grouped boundary node — never folded
 * into a collapsed tool-group where the graph couldn't slot. */
export const ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  "delegate",
  "debate",
]);

/** Whether a tool name hands the turn to a sub-team (see {@link ORCHESTRATION_TOOLS}). */
export function isOrchestrationTool(toolName: string): boolean {
  return ORCHESTRATION_TOOLS.has(toolName);
}

/**
 * Coalesce a process timeline's consecutive tool steps into render nodes: a run of
 * ≥2 adjacent `kind:"tool"` steps becomes one `tool-group`, a lone tool stays an
 * inline `tool`, and every non-tool step (`reasoning`/`content` AND the positional
 * markers `team`/`checkpoint`/`ask`/`plan_review`) passes through unchanged as a
 * boundary that breaks runs — so the true chronological order is fully preserved
 * (前端UX设计.md §一B): the team graph and the interaction cards render at their own
 * marker's slot, not stamped at the bottom. Pure & view-only: `process[]` itself is
 * untouched, so the backend / journal / conformance oracle are unaffected.
 *
 * The trailing content step (the final answer) is a `content` node, never a tool —
 * the answer can never be hidden inside a collapsed group.
 */
export function groupToolRuns(process: ProcessStep[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  let run: ToolStep[] = [];
  const flush = () => {
    if (run.length === 0) return;
    nodes.push(
      run.length === 1
        ? { kind: "tool", step: run[0] }
        : { kind: "tool-group", tools: run },
    );
    run = [];
  };
  for (const step of process) {
    if (step.kind === "tool") {
      run.push(step);
    } else {
      flush();
      nodes.push(step);
    }
  }
  flush();
  return nodes;
}
