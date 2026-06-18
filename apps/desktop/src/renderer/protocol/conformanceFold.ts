// Desktop's fold → ProjectedTurn snapshot adapter for the cross-platform protocol
// 巡检 (手机端落地设计 §六; protocol-conformance.mdc). The conformance test asserts
// this == the backend-exported golden, the SAME golden the mobile fold is pinned to —
// so desktop and mobile can't diverge on the protocol without the gate going red.
//
// AUTHENTICITY: the team-graph projection reuses desktop's REAL pure fold
// (`projectExecution` + `planFromRunPlan` + `frameFromEvent` from stores/execution.ts)
// — the complex, drift-prone surface is the actual production code, not a copy. The
// single-agent scalar lane (content / reasoning / process timeline / citations /
// pending gate / cost) is desktop's live path entangled in Zustand stores + rAF
// (streamConversation.ts), which isn't purely callable here, so it is re-derived to
// the same ProjectedTurn shape and pinned to the golden. Making that lane share one
// pure fold with production is a later rung.
//
// The ProjectedTurn type is mirrored locally (not imported from
// @agentcore/protocol-conformance) so desktop stays decoupled from the workspace
// packages until it formally joins (M1); the committed golden JSON is the real
// contract this is checked against.

import {
  type ExecutionPlan,
  type ExecutionStatus,
  type RunFrame,
  frameFromEvent,
  planFromRunPlan,
  projectExecution,
} from "@/stores/execution";
import type {
  ApprovalRequiredPayload,
  CheckpointRequiredPayload,
  CitationsPayload,
  ContentDeltaPayload,
  MessageEndPayload,
  PlanReviewRequiredPayload,
  ReasoningDeltaPayload,
  RunPlanPayload,
  SSEEvent,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@/types/events";

// --- Local mirror of @agentcore/protocol-conformance ProjectedTurn (judged by the
// committed golden JSON, not by this type) ---

type TurnStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

interface ProcessStepReasoning {
  kind: "reasoning";
  text: string;
}
interface ProcessStepContent {
  kind: "content";
  text: string;
}
interface ProcessStepTool {
  kind: "tool";
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  result: string | null;
  status: "running" | "success" | "error";
  display?: Record<string, unknown> | null;
}
type ProcessStep = ProcessStepReasoning | ProcessStepContent | ProcessStepTool;

interface ProjectedAgent {
  id: string;
  role: string;
  modelPreference: "fast" | "strong";
  thinking: boolean;
  reasoningEffort: "high" | "max" | null;
  status: "idle" | "working" | "completed" | "error" | "cancelled";
  currentRunId: string | null;
  output: string;
  reasoning: string;
  toolProgress: { toolName: string; chars: number } | null;
}

interface ProjectedRun {
  id: string;
  agentId: string;
  task: string;
  status: "pending" | "ready" | "running" | "completed" | "failed" | "cancelled";
  dependsOn: string[];
  outputSummary: string | null;
  durationMs: number | null;
  error: string | null;
  parentRunId: string | null;
  kind: "agent" | "captain";
  role: string | null;
  model: string | null;
  usage: Record<string, number> | null;
  cost: Record<string, unknown> | null;
  stance: "pro" | "con" | null;
  group: string | null;
  round: number;
  revisionOf: string | null;
  revision: number;
  checkpoint: { status: "pending" | "resolved"; decision: string | null } | null;
}

type PendingInteraction =
  | {
      kind: "approval";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { kind: "checkpoint"; checkpointId: string; question: string; context: string }
  | { kind: "plan_review"; checkpointId: string; runIds: string[] };

export interface ProjectedTurn {
  status: TurnStatus;
  finishReason: string | null;
  content: string;
  reasoning: string;
  process: ProcessStep[];
  citations: CitationsPayload["citations"];
  agents: ProjectedAgent[];
  runs: ProjectedRun[];
  progress: { completed: number; total: number };
  pendingInteraction: PendingInteraction | null;
  cost: Record<string, unknown> | null;
}

const FINISH_TO_STATUS: Record<string, TurnStatus> = {
  end_turn: "completed",
  max_rounds: "completed",
  degraded: "completed",
  unproductive: "completed",
  error: "failed",
  cancelled: "cancelled",
};

/** Append unseen agents/runs from a later same-turn delegate batch (mirrors the
 * non-exported `mergePlanInto` in stores/execution.ts). */
function mergePlan(cur: ExecutionPlan, next: ExecutionPlan): ExecutionPlan {
  const agents = [...cur.agents];
  for (const a of next.agents) if (!agents.some((x) => x.id === a.id)) agents.push(a);
  const runs = [...cur.runs];
  for (const s of next.runs) if (!runs.some((x) => x.id === s.id)) runs.push(s);
  return { ...cur, agents, runs, taskSummary: next.taskSummary || cur.taskSummary };
}

/** Desktop's fold → ProjectedTurn (the conformance snapshot). */
export function foldToProjectedTurn(events: SSEEvent[]): ProjectedTurn {
  let content = "";
  let reasoning = "";
  const process: ProcessStep[] = [];
  let citations: CitationsPayload["citations"] = [];
  let status: TurnStatus = "running";
  let finishReason: string | null = null;
  let cost: Record<string, unknown> | null = null;
  let pending: PendingInteraction | null = null;

  // Team graph via the REAL desktop fold: build the plan + frame stream the same way
  // hydrateFromJournal does, then project.
  let plan: ExecutionPlan | null = null;
  const frames: RunFrame[] = [];

  for (const ev of events) {
    switch (ev.type) {
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
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
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
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
        break;
      }
      case "citations":
        citations = (ev.payload as CitationsPayload).citations ?? [];
        break;
      case "run_plan": {
        const next = planFromRunPlan(ev.payload as RunPlanPayload);
        plan = plan && plan.id === next.id ? mergePlan(plan, next) : next;
        break;
      }
      case "run_started":
      case "run_output_delta":
      case "run_reasoning_delta":
      case "run_tool_progress":
      case "run_completed":
      case "run_failed":
      case "run_progress": {
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
        break;
      }
      // plan_review gates the turn (pending) AND folds into the graph as a frame so
      // the gated node carries a checkpoint badge (mirrors streamConversation.ts +
      // the oracle). Handled in this one pass so a later message_end still wins the
      // terminal status.
      case "plan_review_required": {
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
        const p = ev.payload as PlanReviewRequiredPayload;
        pending = {
          kind: "plan_review",
          checkpointId: p.checkpoint_id,
          runIds: (p.steps ?? []).map((s) => s.run_id),
        };
        status = "paused";
        break;
      }
      case "plan_review_resolved": {
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
        const cid = (ev.payload as { checkpoint_id: string }).checkpoint_id;
        if (pending?.kind === "plan_review" && pending.checkpointId === cid) {
          pending = null;
          status = "running";
        }
        break;
      }
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
        const aid = (ev.payload as { approval_id: string }).approval_id;
        if (pending?.kind === "approval" && pending.approvalId === aid) {
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
        const cid = (ev.payload as { checkpoint_id: string }).checkpoint_id;
        if (pending?.kind === "checkpoint" && pending.checkpointId === cid) {
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
        cost = (p.cost ?? null) as Record<string, unknown> | null;
        status = FINISH_TO_STATUS[p.finish_reason] ?? "completed";
        break;
      }
      default:
        // message_start / turn_saved / title_generated / tool_progress /
        // question_posted / workspace_op_required / handoff_* — not part of the
        // normalized judge state.
        break;
    }
  }

  const execStatus: ExecutionStatus = status === "running" ? "running" : status;
  const execution = plan ? projectExecution(plan, frames, execStatus) : null;

  const agents: ProjectedAgent[] = (execution?.agents ?? []).map((a) => ({
    id: a.id,
    role: a.role,
    modelPreference: a.modelPreference,
    thinking: a.thinking,
    reasoningEffort: a.reasoningEffort,
    status: a.status,
    currentRunId: a.currentRunId,
    output: a.outputChunks.join(""),
    reasoning: a.reasoningChunks.join(""),
    toolProgress: a.toolProgress,
  }));

  const runs: ProjectedRun[] = (execution?.runs ?? []).map((r) => ({
    id: r.id,
    agentId: r.agentId,
    task: r.task,
    status: r.status,
    dependsOn: r.dependsOn,
    outputSummary: r.outputSummary,
    durationMs: r.durationMs,
    error: r.error,
    parentRunId: r.parentRunId,
    kind: r.kind,
    role: r.role,
    model: r.model,
    usage: r.usage as Record<string, number> | null,
    cost: r.cost as Record<string, unknown> | null,
    stance: r.stance,
    group: r.group,
    round: r.round,
    revisionOf: r.revisionOf,
    revision: r.revision,
    checkpoint: r.checkpoint,
  }));

  return {
    status,
    finishReason,
    content,
    reasoning,
    process: plan ? [] : process,
    citations,
    agents,
    runs,
    progress: execution
      ? execution.progress
      : { completed: 0, total: 0 },
    pendingInteraction: pending,
    cost,
  };
}
