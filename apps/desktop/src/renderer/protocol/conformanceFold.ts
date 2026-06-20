// Desktop's fold → ProjectedTurn snapshot adapter for the cross-platform protocol
// 巡检 (手机端落地设计 §六; protocol-conformance.mdc). The conformance test asserts
// this == the backend-exported golden, the SAME golden the mobile fold is pinned to —
// so desktop and mobile can't diverge on the protocol without the gate going red.
//
// AUTHENTICITY: the team-graph projection reuses desktop's REAL pure fold
// (`projectExecution` + `planFromRunPlan` + `frameFromEvent` from stores/execution.ts)
// — the complex, drift-prone surface is the actual production code, not a copy. The
// single-agent process timeline (思考·正文·工具) now ALSO reuses the same pure helpers
// production renders through (`@/lib/processTimeline`, shared with stores/
// conversation.ts), so that lane is production-sourced too — no second coalesce rule
// to drift. Only the thin turn-level scalars (content / reasoning strings / citations /
// pending gate / cost) are assembled here to build the ProjectedTurn the golden judges.
//
// ProjectedTurn (+ its sub-shapes) is imported from the shared
// @agentcore/protocol-conformance package now that desktop has joined the workspace —
// one judge type for both ends; the committed golden JSON is the real contract checked.

import {
  appendContentStep,
  appendReasoningStep,
  appendToolStep,
  dropTrailingContentSteps,
  resolveToolStep,
} from "@/lib/processTimeline";
import {
  type ExecutionPlan,
  type ExecutionStatus,
  type RunFrame,
  frameFromEvent,
  planFromRunPlan,
  projectExecution,
  upsertDebateRound,
} from "@/stores/execution";
import type {
  ApprovalRequiredPayload,
  CheckpointRequiredPayload,
  CitationsPayload,
  ContentDeltaPayload,
  DebateNarrativeRound,
  DebateResultPayload,
  DebateRoundPayload,
  DebateRoundStartedPayload,
  MessageEndPayload,
  PlanReviewRequiredPayload,
  ReasoningDeltaPayload,
  RunPlanPayload,
  SSEEvent,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@/types/events";
import type {
  CostBreakdown,
  PendingInteraction,
  ProcessStep,
  ProjectedAgent,
  ProjectedCitation,
  ProjectedRun,
  ProjectedTurn,
  TurnStatus,
} from "@agentcore/protocol-conformance/projectedTurn";

export type { ProjectedTurn };

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
  for (const a of next.agents)
    if (!agents.some((x) => x.id === a.id)) agents.push(a);
  const runs = [...cur.runs];
  for (const s of next.runs) if (!runs.some((x) => x.id === s.id)) runs.push(s);
  return {
    ...cur,
    agents,
    runs,
    taskSummary: next.taskSummary || cur.taskSummary,
  };
}

/** Desktop's fold → ProjectedTurn (the conformance snapshot). */
export function foldToProjectedTurn(events: SSEEvent[]): ProjectedTurn {
  let content = "";
  let reasoning = "";
  let process: ProcessStep[] = [];
  let citations: ProjectedCitation[] = [];
  let status: TurnStatus = "running";
  let finishReason: string | null = null;
  let cost: CostBreakdown | null = null;
  let debate: DebateResultPayload | null = null;
  let debateRounds: DebateNarrativeRound[] = [];
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
        if (d) process = appendContentStep(process, d);
        break;
      }
      // 交付前核验回炉（finish_guard）：done 轮草稿未过轻层核验，引擎丢弃这一版、发
      // content_reset、回炉重写。content_reset 进 _history（重连回放会重发），故 fold 必须
      // 镜像生产端（stores/conversation.ts resetStreamingContent）与后端
      // （EventSink._accumulate_process）：清正文标量 + 弹掉 process 尾部连续 content 步，
      // 让重写版从干净态重新累积——否则巡检 fold 会把「违规版+修正版」拼在一起、与生产漂移。
      case "content_reset": {
        content = "";
        process = dropTrailingContentSteps(process);
        break;
      }
      case "reasoning_delta": {
        const d = (ev.payload as ReasoningDeltaPayload).delta || "";
        reasoning += d;
        if (d) process = appendReasoningStep(process, d);
        break;
      }
      case "tool_use_start": {
        const p = ev.payload as ToolUseStartPayload;
        process = appendToolStep(process, p);
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
        break;
      }
      case "tool_use_end": {
        const p = ev.payload as ToolUseEndPayload;
        const resolved = resolveToolStep(process, p);
        if (resolved) process = resolved;
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
      case "run_context":
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
      // 辩论收场产物（回合级单事件，非 frame）：verbatim 折入，与 oracle 一致。
      case "debate_result": {
        debate = ev.payload as DebateResultPayload;
        break;
      }
      // 辩论逐轮增量（进行中实时叠加，非 frame）：折叠累积成 debateRounds，与 oracle / 手机
      // fold 一致。round_started 先给焦点（verdict=null=进行中），round 补 summary/verdict/sides。
      case "debate_round_started": {
        const p = ev.payload as DebateRoundStartedPayload;
        debateRounds = upsertDebateRound(debateRounds, {
          round_no: p.round_no,
          focus: p.focus,
          summary: "",
          verdict: null,
          sides: [],
        });
        break;
      }
      case "debate_round": {
        const p = ev.payload as DebateRoundPayload;
        debateRounds = upsertDebateRound(debateRounds, {
          round_no: p.round_no,
          focus: p.focus,
          summary: p.summary,
          verdict: p.verdict,
          sides: p.sides,
        });
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
        cost = p.cost ?? null;
        status = FINISH_TO_STATUS[p.finish_reason] ?? "completed";
        break;
      }
      default:
        // message_start / turn_saved / title_generated / tool_progress /
        // question_posted / workspace_op_required / workspace_promoted / handoff_* —
        // not part of the normalized judge state.
        break;
    }
  }

  const execStatus: ExecutionStatus = status === "running" ? "running" : status;
  const execution = plan
    ? projectExecution(plan, frames, execStatus, debate, debateRounds)
    : null;

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
    usage: r.usage,
    cost: r.cost,
    stance: r.stance,
    group: r.group,
    round: r.round,
    revisionOf: r.revisionOf,
    revision: r.revision,
    checkpoint: r.checkpoint,
    receivedContext: r.receivedContext,
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
    progress: execution ? execution.progress : { completed: 0, total: 0 },
    pendingInteraction: pending,
    cost,
    debate,
    debateRounds,
  };
}
