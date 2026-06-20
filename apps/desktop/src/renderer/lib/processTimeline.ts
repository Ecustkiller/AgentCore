// 单聊 process timeline 的纯 fold helpers（思考·正文·工具内联时间线，前端UX设计.md §一B）。
//
// 生产实时渲染（stores/conversation.ts 的 append*/endProcessTool mutator）与跨端协议
// 巡检（protocol/conformanceFold.ts）共用这一组纯函数——单聊标量道由此「生产/巡检同源」，
// 杜绝两份 coalesce 规则漂移。三者都镜像后端 EventSink._accumulate_process（runtime/
// events.py），故 live 流、reload 回放、conformance golden 读到同一形状。
//
// 不可变：每个 append* 返回新 process 数组；resolveToolStep 在无匹配时返回原引用，便于
// store 做 no-op 短路。

import type {
  ProcessStep,
  ToolUseEndPayload,
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

/** Append a started tool call as a `running` step to the timeline. */
export function appendToolStep(
  process: ProcessStep[] | undefined,
  payload: ToolUseStartPayload,
): ProcessStep[] {
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

/** A tool step (narrowed from {@link ProcessStep}). */
export type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

/**
 * A render node for the inline timeline after consecutive tool steps are coalesced
 * (前端UX设计.md §一B). `reasoning` / `content` stay 1:1 with their steps (they are
 * the natural boundaries that break a run → 保序); a maximal run of ≥2 adjacent tool
 * steps folds into one collapsible `tool-group`; a lone tool stays inline as `tool`
 * (阈值 ≥2 — 单个不套壳，维持现状平铺).
 */
export type TimelineNode =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | { kind: "tool"; step: ToolStep }
  | { kind: "tool-group"; tools: ToolStep[] };

/**
 * Coalesce a process timeline's consecutive tool steps into render nodes: a run of
 * ≥2 adjacent `kind:"tool"` steps becomes one `tool-group`, a lone tool stays an
 * inline `tool`, and `reasoning`/`content` steps pass through unchanged as the
 * boundaries that break runs — so the true chronological order is fully preserved
 * (前端UX设计.md §一B). Pure & view-only: `process[]` itself is untouched, so the
 * backend / journal / conformance oracle are unaffected.
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
