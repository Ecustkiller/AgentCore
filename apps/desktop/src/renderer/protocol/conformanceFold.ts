// Desktop's fold → ProjectedTurn snapshot adapter for the cross-platform protocol
// 巡检 (前端技术与架构 §十二; protocol-conformance.mdc). The conformance test asserts
// this == the backend-exported golden, the SAME golden the mobile fold is pinned to —
// so desktop and mobile can't diverge on the protocol without the gate going red.
//
// AUTHENTICITY: the team-graph projection reuses desktop's REAL pure fold
// (`projectExecution` + `planFromRunPlan` + `frameFromEvent` from stores/execution.ts)
// — the complex, drift-prone surface is the actual production code, not a copy. The
// process timeline (思考·正文·工具, single-agent AND multi-agent — 统一团队时间线) now ALSO
// reuses production-sourced helpers (`@/lib/foldMessageLane` + `processTimeline`,
// shared with stores/conversation.ts) so live / reload / golden stay aligned.
//
// ProjectedTurn (+ its sub-shapes) is imported from the shared
// @agentcore/protocol-conformance package now that desktop has joined the workspace —
// one judge type for both ends; the committed golden JSON is the real contract checked.

import {
  type MessageLaneState,
  foldAskMarker,
  foldCheckpointMarker,
  foldCitations,
  foldContentDelta,
  foldContentReset,
  foldPlanReviewMarker,
  foldReasoningDelta,
  foldTeamMarker,
  foldToolUseEnd,
  foldToolUseStart,
} from "@/lib/foldMessageLane";
import {
  type ExecutionPlan,
  type ExecutionStatus,
  type RunFrame,
  frameFromEvent,
  mergePlanInto,
  planFromRunPlan,
  projectExecution,
  upsertDebateRound,
} from "@/stores/execution";
import type {
  ApprovalRequiredPayload,
  CheckpointRequiredPayload,
  CitationsPayload,
  ContentDeltaPayload,
  ContextBlockWire,
  DebateNarrativeRound,
  DebateResultPayload,
  DebateRoundPayload,
  DebateRoundStartedPayload,
  MessageEndPayload,
  PlanReviewRequiredPayload,
  QuestionPostedPayload,
  ReasoningDeltaPayload,
  RunContextPayload,
  RunPlanPayload,
  RunStartedPayload,
  SSEEvent,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@/types/events";
import type {
  CostBreakdown,
  PendingInteraction,
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
  // 挂起即收口 (②): a turn finalized AT a durable checkpoint ends with finish_reason=paused
  // — a terminal message_end whose turn is NOT done. Stay paused (the *_required already set
  // status + pendingInteraction; this only adds finishReason + cost) so the single resume
  // card renders, not a completed bubble. Without this it'd fall to "completed" below.
  paused: "paused",
};

/** Desktop's fold → ProjectedTurn (the conformance snapshot). */
export function foldToProjectedTurn(events: SSEEvent[]): ProjectedTurn {
  let messageLane: MessageLaneState = {
    content: "",
    reasoning: "",
    process: [],
    citations: [],
  };
  let status: TurnStatus = "running";
  let finishReason: string | null = null;
  let cost: CostBreakdown | null = null;
  let debate: DebateResultPayload | null = null;
  let debateRounds: DebateNarrativeRound[] = [];
  let pending: PendingInteraction | null = null;
  // 收到的上下文 · CEO 侧 (上下文传递可视化): the captain run id (its kind=captain
  // run_started) + the opening context it was fed, routed turn-level — the CEO is the
  // bubble above the graph, not a peer node, so its run_context never becomes a frame.
  let captainRunId: string | null = null;
  let captainContext: ContextBlockWire[] = [];

  // Team graph via the REAL desktop fold: build the plan + frame stream the same way
  // hydrateFromJournal does, then project.
  let plan: ExecutionPlan | null = null;
  const frames: RunFrame[] = [];

  for (const ev of events) {
    switch (ev.type) {
      case "content_delta":
        messageLane = foldContentDelta(
          messageLane,
          (ev.payload as ContentDeltaPayload).delta,
        );
        break;
      case "content_reset":
        messageLane = foldContentReset(messageLane);
        break;
      case "reasoning_delta":
        messageLane = foldReasoningDelta(
          messageLane,
          (ev.payload as ReasoningDeltaPayload).delta,
        );
        break;
      case "tool_use_start":
        messageLane = foldToolUseStart(
          messageLane,
          ev.payload as ToolUseStartPayload,
        );
        {
          const frame = frameFromEvent(ev);
          if (frame) frames.push(frame);
        }
        break;
      case "tool_use_end":
        messageLane = foldToolUseEnd(
          messageLane,
          ev.payload as ToolUseEndPayload,
        );
        {
          const frame = frameFromEvent(ev);
          if (frame) frames.push(frame);
        }
        break;
      case "citations":
        messageLane = foldCitations(
          messageLane,
          (ev.payload as CitationsPayload).citations ?? [],
        );
        break;
      case "run_plan": {
        const next = planFromRunPlan(ev.payload as RunPlanPayload);
        plan = plan && plan.id === next.id ? mergePlanInto(plan, next) : next;
        // 协作图时间线落点: the first plan of an execution drops a `team` marker fixing
        // the graph's slot in the CEO timeline (later same-id batches no-op).
        messageLane = foldTeamMarker(messageLane, next.id);
        break;
      }
      case "run_started": {
        // The CEO captain is the turn's root (kind=captain); remember its run id so its
        // run_context routes turn-level (its node still folds via the frame like any run).
        const p = ev.payload as RunStartedPayload;
        if (p.kind === "captain") captainRunId = p.run_id;
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
        break;
      }
      case "run_context": {
        // The CAPTAIN's context routes TURN-LEVEL onto captainContext (the CEO is the
        // bubble above the graph, not a node — shows on every turn, pure chat included),
        // APPENDING across emits so its context GROWS by each post-delegation team readback
        // (通道⑤); a WORKER's stays a frame so projectExecution folds it onto its graph node.
        const p = ev.payload as RunContextPayload;
        if (p.run_id === captainRunId) {
          captainContext = [...captainContext, ...p.blocks];
          break;
        }
        const frame = frameFromEvent(ev);
        if (frame) frames.push(frame);
        break;
      }
      case "run_output_delta":
      // 交付前核验回炉 (finish_guard) 的 worker 对偶: run_output_reset folds via the same frame
      // path — projectExecution clears the agent's outputChunks so the rewrite replaces the
      // discarded draft (content_reset 之于 CEO 气泡). Mirrors the oracle + mobile fold.
      case "run_output_reset":
      case "run_reasoning_delta":
      case "run_tool_progress":
      case "run_completed":
      case "run_failed":
      case "run_progress":
      //「计划已调整」轻痕迹 (设计 §7.2): a NON-interrupting trace — folds onto the runs'
      // `revised` via the same frame path (no gate, like the escalate banner).
      case "plan_revised":
      case "run_escalation":
      // 阻塞式求决策: the blocking-escalate pair folds onto the run's escalations via the
      // same frame path (projectExecution appends pending / flips resolved). The turn does
      // NOT pause on these (siblings keep running), so unlike the gates they set no pending.
      case "escalation_required":
      case "escalation_resolved":
      // 团队便签墙 (§2.2 通): a worker broadcast a one-line decision / heads-up to its concurrent
      // siblings — folds turn-level onto Execution.teamNotes via the same frame path (post order,
      // deduped by noteId). Mirrors the backend oracle + mobile fold (conformance pins them equal).
      case "team_note_posted": {
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
          clashes: [],
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
          clashes: p.clashes,
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
        messageLane = foldPlanReviewMarker(messageLane, p.checkpoint_id);
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
        messageLane = foldCheckpointMarker(messageLane, p.checkpoint_id);
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
      case "question_posted": {
        const p = ev.payload as QuestionPostedPayload;
        messageLane = foldAskMarker(messageLane, p.ask_id);
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
        // message_start / turn_saved / title_generated / followups_generated /
        // board_op_required / board_read_required / tool_progress / tool_use_progress /
        // workspace_op_required / handoff_* — not part of the normalized
        // judge state (tool_use_progress is transport-only 工具执行阶段进度: live-stream phase,
        // never journaled, so it never rides a vector and carries no ProjectedTurn state).
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
    debrief: r.debrief,
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
    revised: r.revised,
    checkpoint: r.checkpoint,
    receivedContext: r.receivedContext,
    // Strip the desktop-local `id` (the resolve target): the conformance RunEscalation is the
    // 5-field {question, assumption, blocking, status, answer} the oracle golden carries — keeping
    // `id` out here is what lets us thread it through the store without widening the cross-end contract.
    escalations: r.escalations.map((e) => ({
      question: e.question,
      assumption: e.assumption,
      blocking: e.blocking,
      status: e.status,
      answer: e.answer,
    })),
  }));

  return {
    status,
    finishReason,
    content: messageLane.content,
    reasoning: messageLane.reasoning,
    captainContext,
    process: messageLane.process,
    citations: messageLane.citations as ProjectedCitation[],
    agents,
    runs,
    progress: execution ? execution.progress : { completed: 0, total: 0 },
    pendingInteraction: pending,
    cost,
    debate,
    debateRounds,
    // 团队便签墙 (§2.2 通): single source = projectExecution's frame fold (above), mapped to the
    // golden's ProjectedTeamNote shape — the same single-source pattern as `escalations`.
    teamNotes: (execution?.teamNotes ?? []).map((n) => ({
      noteId: n.noteId,
      runId: n.runId,
      agentId: n.agentId,
      role: n.role,
      kind: n.kind,
      text: n.text,
      ts: n.ts,
      status: n.status,
      supersedes: n.supersedes,
      ...(n.source ? { source: n.source } : {}),
    })),
  };
}
