import type {
  CheckpointDecision,
  ContextBlockWire,
  EscalationRequiredPayload,
  EscalationResolvedPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  PlanRevisedPayload,
  PlanRevisionKind,
  RunCompletedPayload,
  RunContextPayload,
  RunEscalationPayload,
  RunFailedPayload,
  RunKind,
  RunOutputDeltaPayload,
  RunProgressPayload,
  RunReasoningDeltaPayload,
  RunStartedPayload,
  RunToolProgressPayload,
  SSEEvent,
  ToolDisplay,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@/types/events";

/**
 * One recorded run-level fact. The frame stream is append-only and is the
 * single source of truth for the collaboration graph — mirroring the backend
 * Turn Journal. "Live" is simply playhead = end-of-stream; "replay" is any
 * earlier playhead. Both render through the same {@link projectExecution} fold,
 * so there is no second code path to keep in sync.
 */
export type RunFrame =
  | {
      t: number;
      kind: "run_started";
      agentId: string;
      runId: string;
      // `runKind` (not `kind`) because `kind` is this union's discriminant; it
      // carries the wire `kind` (captain/agent).
      parentRunId: string | null;
      runKind: RunKind;
      // 续写 version (乙 热修 P4): 0 for an ordinary run, >=2 for a revision (then
      // parentRunId is the original run it revises).
      revision: number;
    }
  | {
      t: number;
      kind: "run_context";
      runId: string;
      // 收到的上下文 (上下文传递可视化): the wire ContextBlocks this run was fed.
      blocks: ContextBlockWire[];
    }
  | { t: number; kind: "run_output_delta"; agentId: string; delta: string }
  | { t: number; kind: "run_reasoning_delta"; agentId: string; delta: string }
  | {
      t: number;
      kind: "run_tool_progress";
      agentId: string;
      toolName: string;
      chars: number;
    }
  | {
      t: number;
      kind: "run_completed";
      runId: string;
      agentId: string;
      outputSummary: string;
      durationMs: number;
      // Cost-ledger fields from `run_completed` (§7.3B payroll). Optional so a
      // frame without them (older streams / a journal replay that lacks cost)
      // still projects — the run simply carries no priced cost.
      role?: string;
      model?: string;
      usage?: import("@/types/events").UsageBreakdown;
      cost?: import("@/types/events").CostBreakdown;
    }
  | {
      t: number;
      kind: "run_failed";
      runId: string;
      agentId: string;
      error: string;
    }
  | { t: number; kind: "run_progress"; completed: number; total: number }
  | {
      t: number;
      kind: "run_escalation";
      runId: string;
      agentId: string;
      question: string;
      assumption: string;
      blocking: boolean;
    }
  | {
      // 阻塞式求决策: a worker SUSPENDED on a blocking escalate, awaiting the user.
      t: number;
      kind: "escalation_required";
      // The interaction id the EscalationCard resolves against (POST …/interactions/{id}).
      escalationId: string;
      runId: string;
      agentId: string;
      question: string;
      assumption: string;
    }
  | {
      // 阻塞式求决策 settlement: the blocking escalate resolved (answer) or timed out.
      t: number;
      kind: "escalation_resolved";
      runId: string;
      agentId: string;
      status: "resolved" | "timeout";
      answer: string;
    }
  | {
      t: number;
      kind: "tool_use_start";
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      t: number;
      kind: "tool_use_end";
      toolCallId: string;
      result: string;
      display?: ToolDisplay | null;
      status: "success" | "error";
    }
  | {
      t: number;
      kind: "plan_review_required";
      checkpointId: string;
      // The just-completed step run ids this pause gates on (the badge targets).
      runIds: string[];
    }
  | {
      t: number;
      kind: "plan_review_resolved";
      checkpointId: string;
      decision: CheckpointDecision;
    }
  | {
      // 「计划已调整」轻痕迹 (设计 §7.2): the CEO autonomously re-bound / re-steered
      // paused nodes via replan. Each entry tags an affected node's graph trace.
      t: number;
      kind: "plan_revised";
      revisions: { runId: string; revisionKind: PlanRevisionKind }[];
    };

/** Wall-clock time of a wire event (ms), used to label timeline frames. The
 * journal stores the same ISO timestamp the live stream carried, so replay and
 * live label frames identically. */
function frameTimeOf(event: SSEEvent): number {
  const parsed = Date.parse(event.timestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Map a journaled run/tool SSE event to a {@link RunFrame}, or null for events
 * that are not frames (e.g. `run_plan`). The single event→frame mapping shared
 * by the live SSE dispatch and journal replay, so there is one fold, not two. */
export function frameFromEvent(event: SSEEvent): RunFrame | null {
  const t = frameTimeOf(event);
  switch (event.type) {
    case "run_started": {
      const p = event.payload as RunStartedPayload;
      return {
        t,
        kind: "run_started",
        agentId: p.agent_id,
        runId: p.run_id,
        parentRunId: p.parent_run_id,
        runKind: p.kind,
        revision: p.revision ?? 0,
      };
    }
    case "run_context": {
      const p = event.payload as RunContextPayload;
      return {
        t,
        kind: "run_context",
        runId: p.run_id,
        blocks: p.blocks,
      };
    }
    case "run_output_delta": {
      const p = event.payload as RunOutputDeltaPayload;
      return {
        t,
        kind: "run_output_delta",
        agentId: p.agent_id,
        delta: p.delta,
      };
    }
    case "run_reasoning_delta": {
      const p = event.payload as RunReasoningDeltaPayload;
      return {
        t,
        kind: "run_reasoning_delta",
        agentId: p.agent_id,
        delta: p.delta,
      };
    }
    case "run_tool_progress": {
      const p = event.payload as RunToolProgressPayload;
      return {
        t,
        kind: "run_tool_progress",
        agentId: p.agent_id,
        toolName: p.tool_name,
        chars: p.chars,
      };
    }
    case "run_completed": {
      const p = event.payload as RunCompletedPayload;
      return {
        t,
        kind: "run_completed",
        runId: p.run_id,
        agentId: p.agent_id,
        outputSummary: p.output_summary,
        durationMs: p.duration_ms,
        role: p.role,
        model: p.model,
        usage: p.usage,
        cost: p.cost,
      };
    }
    case "run_failed": {
      const p = event.payload as RunFailedPayload;
      return {
        t,
        kind: "run_failed",
        runId: p.run_id,
        agentId: p.agent_id,
        error: p.error,
      };
    }
    case "run_progress": {
      const p = event.payload as RunProgressPayload;
      return {
        t,
        kind: "run_progress",
        completed: p.completed,
        total: p.total,
      };
    }
    case "run_escalation": {
      const p = event.payload as RunEscalationPayload;
      return {
        t,
        kind: "run_escalation",
        runId: p.run_id,
        agentId: p.agent_id,
        question: p.question,
        assumption: p.assumption,
        blocking: p.blocking,
      };
    }
    case "escalation_required": {
      const p = event.payload as EscalationRequiredPayload;
      return {
        t,
        kind: "escalation_required",
        escalationId: p.escalation_id,
        runId: p.run_id,
        agentId: p.agent_id,
        question: p.question,
        assumption: p.assumption,
      };
    }
    case "escalation_resolved": {
      const p = event.payload as EscalationResolvedPayload;
      return {
        t,
        kind: "escalation_resolved",
        runId: p.run_id,
        agentId: p.agent_id,
        status: p.status,
        answer: p.answer,
      };
    }
    case "tool_use_start": {
      const p = event.payload as ToolUseStartPayload;
      return {
        t,
        kind: "tool_use_start",
        toolCallId: p.tool_call_id,
        toolName: p.tool_name,
        arguments: p.arguments,
      };
    }
    case "tool_use_end": {
      const p = event.payload as ToolUseEndPayload;
      return {
        t,
        kind: "tool_use_end",
        toolCallId: p.tool_call_id,
        result: p.result,
        display: p.display ?? null,
        status: p.status,
      };
    }
    case "plan_review_required": {
      const p = event.payload as PlanReviewRequiredPayload;
      return {
        t,
        kind: "plan_review_required",
        checkpointId: p.checkpoint_id,
        runIds: (p.steps ?? []).map((s) => s.run_id),
      };
    }
    case "plan_review_resolved": {
      const p = event.payload as PlanReviewResolvedPayload;
      return {
        t,
        kind: "plan_review_resolved",
        checkpointId: p.checkpoint_id,
        decision: p.decision,
      };
    }
    case "plan_revised": {
      const p = event.payload as PlanRevisedPayload;
      return {
        t,
        kind: "plan_revised",
        revisions: p.revisions.map((r) => ({
          runId: r.run_id,
          revisionKind: r.kind,
        })),
      };
    }
    default:
      return null;
  }
}
