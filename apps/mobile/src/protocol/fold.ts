// The mobile protocol fold: SSE events → normalized ProjectedTurn (手机端落地设计 §六).
//
// This is the ONE dangerous surface the conformance巡检 guards (cross-platform-
// frontend.mdc §四): it must match the backend oracle's golden for every vector
// (`pnpm conformance`). It is a brand-new mobile implementation — NOT shared with
// desktop's `projectExecution` — but behaviorally aligned to the same golden.
//
// Exhaustive `switch` + `assertNever` (支柱2): a new backend SSE type added to
// @agentcore/contract-types breaks this build until it is handled here.

import type {
  ContentDeltaPayload,
  CostBreakdown,
  ApprovalRequiredPayload,
  ApprovalResolvedPayload,
  CheckpointRequiredPayload,
  CheckpointResolvedPayload,
  CitationsPayload,
  MessageEndPayload,
  PlanAgentPayload,
  PlanReviewRequiredPayload,
  PlanReviewResolvedPayload,
  ReasoningDeltaPayload,
  RunCompletedPayload,
  RunFailedPayload,
  RunOutputDeltaPayload,
  RunPlanPayload,
  RunReasoningDeltaPayload,
  RunStartedPayload,
  RunToolProgressPayload,
  SSEEvent,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@agentcore/contract-types";
import type {
  PendingInteraction,
  ProcessStep,
  ProjectedAgent,
  ProjectedCitation,
  ProjectedRun,
  ProjectedTurn,
  TurnStatus,
} from "@agentcore/protocol-conformance";

const FINISH_TO_STATUS: Record<string, TurnStatus> = {
  end_turn: "completed",
  max_rounds: "completed",
  degraded: "completed",
  unproductive: "completed",
  error: "failed",
  cancelled: "cancelled",
};

function assertNever(x: never): never {
  throw new Error(`fold: unhandled SSE event type: ${JSON.stringify(x)}`);
}

function agentFromPlan(a: PlanAgentPayload): ProjectedAgent {
  return {
    id: a.id,
    role: a.role,
    modelPreference: a.model_preference,
    thinking: a.thinking,
    reasoningEffort: a.reasoning_effort,
    status: "idle",
    currentRunId: null,
    output: "",
    reasoning: "",
    toolProgress: null,
  };
}

function runFromPlan(s: RunPlanPayload["runs"][number]): ProjectedRun {
  return {
    id: s.id,
    agentId: s.agent_id,
    task: s.task,
    status: "pending",
    dependsOn: s.depends_on ?? [],
    outputSummary: null,
    durationMs: null,
    error: null,
    parentRunId: s.parent_run_id ?? null,
    kind: s.kind ?? "agent",
    role: null,
    model: null,
    usage: null,
    cost: null,
    stance: s.stance ?? null,
    group: s.group ?? null,
    round: s.round ?? 0,
    revisionOf: null,
    revision: 0,
    checkpoint: null,
  };
}

export function fold(events: SSEEvent[]): ProjectedTurn {
  let content = "";
  let reasoning = "";
  const process: ProcessStep[] = [];
  let citations: ProjectedCitation[] = [];
  const agents: ProjectedAgent[] = [];
  const runs: ProjectedRun[] = [];
  let hasRunPlan = false;
  let planId: string | null = null;
  let status: TurnStatus = "running";
  let finishReason: string | null = null;
  let cost: CostBreakdown | null = null;
  let pending: PendingInteraction | null = null;
  const checkpointSteps = new Map<string, string[]>();

  const agentById = (id: string) => agents.find((a) => a.id === id);
  const runById = (id: string) => runs.find((r) => r.id === id);

  for (const ev of events) {
    const type = ev.type;
    switch (type) {
      case "content_delta": {
        const d = (ev.payload as ContentDeltaPayload).delta || "";
        content += d;
        if (d) {
          const last = process[process.length - 1];
          if (last && last.kind === "content") last.text += d;
          else process.push({ kind: "content", text: d });
        }
        break;
      }
      case "reasoning_delta": {
        const d = (ev.payload as ReasoningDeltaPayload).delta || "";
        reasoning += d;
        if (d) {
          const last = process[process.length - 1];
          if (last && last.kind === "reasoning") last.text += d;
          else process.push({ kind: "reasoning", text: d });
        }
        break;
      }
      case "tool_use_start": {
        const p = ev.payload as ToolUseStartPayload;
        process.push({
          kind: "tool",
          id: p.tool_call_id,
          tool_name: p.tool_name,
          arguments: p.arguments ?? {},
          result: null,
          status: "running",
        });
        const running = runs.find((r) => r.status === "running");
        if (running) {
          const ag = agentById(running.agentId);
          if (ag) ag.toolProgress = null;
        }
        break;
      }
      case "tool_use_end": {
        const p = ev.payload as ToolUseEndPayload;
        for (let i = process.length - 1; i >= 0; i--) {
          const step = process[i];
          if (step.kind === "tool" && step.id === p.tool_call_id) {
            step.result = p.result;
            step.status = p.status;
            if (p.display != null) step.display = p.display;
            break;
          }
        }
        break;
      }
      case "citations": {
        citations = (ev.payload as CitationsPayload).citations ?? [];
        break;
      }
      case "run_plan": {
        hasRunPlan = true;
        const p = ev.payload as RunPlanPayload;
        if (planId === null || planId === p.execution_id) {
          planId = p.execution_id;
          for (const a of p.agents) if (!agentById(a.id)) agents.push(agentFromPlan(a));
          for (const s of p.runs) if (!runById(s.id)) runs.push(runFromPlan(s));
        } else {
          planId = p.execution_id;
          agents.length = 0;
          runs.length = 0;
          for (const a of p.agents) agents.push(agentFromPlan(a));
          for (const s of p.runs) runs.push(runFromPlan(s));
        }
        break;
      }
      case "run_started": {
        const p = ev.payload as RunStartedPayload;
        const revision = p.revision ?? 0;
        let run = runById(p.run_id);
        if (!run && revision > 0 && p.parent_run_id) {
          const original = runById(p.parent_run_id);
          if (original) {
            const originAgent = agentById(original.agentId);
            agents.push({
              id: p.agent_id,
              role: originAgent?.role ?? original.agentId,
              modelPreference: originAgent?.modelPreference ?? "strong",
              thinking: originAgent?.thinking ?? true,
              reasoningEffort: originAgent?.reasoningEffort ?? "high",
              status: "idle",
              currentRunId: null,
              output: "",
              reasoning: "",
              toolProgress: null,
            });
            run = {
              ...runFromPlan({
                id: p.run_id,
                agent_id: p.agent_id,
                task: original.task,
                depends_on: [],
              }),
              parentRunId: p.parent_run_id,
              kind: p.kind,
              revisionOf: p.parent_run_id,
              revision,
            };
            runs.push(run);
          }
        }
        if (run) {
          run.status = "running";
          run.parentRunId = p.parent_run_id;
          run.kind = p.kind;
        }
        const ag = agentById(p.agent_id);
        if (ag) {
          ag.status = "working";
          ag.currentRunId = p.run_id;
          ag.toolProgress = null;
        }
        break;
      }
      case "run_output_delta": {
        const p = ev.payload as RunOutputDeltaPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.output += p.delta || "";
        break;
      }
      case "run_reasoning_delta": {
        const p = ev.payload as RunReasoningDeltaPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.reasoning += p.delta || "";
        break;
      }
      case "run_tool_progress": {
        const p = ev.payload as RunToolProgressPayload;
        const ag = agentById(p.agent_id);
        if (ag) ag.toolProgress = { toolName: p.tool_name, chars: p.chars };
        break;
      }
      case "run_completed": {
        const p = ev.payload as RunCompletedPayload;
        const run = runById(p.run_id);
        if (run) {
          run.status = "completed";
          run.outputSummary = p.output_summary;
          run.durationMs = p.duration_ms;
          run.role = p.role;
          run.model = p.model;
          run.usage = p.usage;
          run.cost = p.cost;
        }
        const ag = agentById(p.agent_id);
        if (ag) {
          ag.status = "completed";
          ag.currentRunId = null;
          ag.toolProgress = null;
        }
        break;
      }
      case "run_failed": {
        const p = ev.payload as RunFailedPayload;
        const run = runById(p.run_id);
        if (run) {
          run.status = "failed";
          run.error = p.error;
        }
        const ag = agentById(p.agent_id);
        if (ag) {
          ag.status = "error";
          ag.toolProgress = null;
        }
        break;
      }
      case "run_progress":
        // Derived below from run states (cumulative, multi-batch safe); wire counter
        // is a timeline marker only.
        break;
      case "approval_required": {
        const p = ev.payload as ApprovalRequiredPayload;
        pending = {
          kind: "approval",
          approvalId: p.approval_id,
          toolCallId: p.tool_call_id,
          toolName: p.tool_name,
          arguments: p.arguments ?? {},
        };
        status = "paused";
        break;
      }
      case "approval_resolved": {
        const p = ev.payload as ApprovalResolvedPayload;
        if (pending?.kind === "approval" && pending.approvalId === p.approval_id) {
          pending = null;
          status = "running";
        }
        break;
      }
      case "checkpoint_required": {
        const p = ev.payload as CheckpointRequiredPayload;
        pending = {
          kind: "checkpoint",
          checkpointId: p.checkpoint_id,
          question: p.question,
          context: p.context,
        };
        status = "paused";
        break;
      }
      case "checkpoint_resolved": {
        const p = ev.payload as CheckpointResolvedPayload;
        if (pending?.kind === "checkpoint" && pending.checkpointId === p.checkpoint_id) {
          pending = null;
          status = "running";
        }
        break;
      }
      case "plan_review_required": {
        const p = ev.payload as PlanReviewRequiredPayload;
        const runIds = (p.steps ?? []).map((s) => s.run_id);
        checkpointSteps.set(p.checkpoint_id, runIds);
        for (const rid of runIds) {
          const run = runById(rid);
          if (run) run.checkpoint = { status: "pending", decision: null };
        }
        pending = { kind: "plan_review", checkpointId: p.checkpoint_id, runIds };
        status = "paused";
        break;
      }
      case "plan_review_resolved": {
        const p = ev.payload as PlanReviewResolvedPayload;
        for (const rid of checkpointSteps.get(p.checkpoint_id) ?? []) {
          const run = runById(rid);
          if (run) run.checkpoint = { status: "resolved", decision: p.decision };
        }
        if (pending?.kind === "plan_review" && pending.checkpointId === p.checkpoint_id) {
          pending = null;
          status = "running";
        }
        break;
      }
      case "error":
        status = "failed";
        break;
      case "message_end": {
        const p = ev.payload as MessageEndPayload;
        finishReason = p.finish_reason;
        cost = p.cost ?? null;
        status = FINISH_TO_STATUS[p.finish_reason] ?? "completed";
        break;
      }
      // Not part of the normalized turn judge state (no-op) — but enumerated so the
      // assertNever below stays exhaustive against @agentcore/contract-types.
      case "message_start":
      case "turn_saved":
      case "title_generated":
      case "tool_progress":
      case "question_posted":
      case "workspace_op_required":
      case "handoff_snapshot_done":
      case "handoff_job_started":
      case "handoff_apply_done":
        break;
      default:
        assertNever(type);
    }
  }

  if (status === "cancelled") {
    for (const r of runs) if (r.status === "running") r.status = "cancelled";
    for (const a of agents) if (a.status === "working") a.status = "cancelled";
  }

  return {
    status,
    finishReason,
    content,
    reasoning,
    process: hasRunPlan ? [] : process,
    citations,
    agents,
    runs,
    progress: {
      completed: runs.filter((r) => r.status === "completed").length,
      total: runs.length,
    },
    pendingInteraction: pending,
    cost,
  };
}
