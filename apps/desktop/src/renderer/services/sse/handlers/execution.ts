import { useConversationStore } from "@/stores/conversation";
import {
  frameFromEvent,
  planFromRunPlan,
  useExecutionStore,
} from "@/stores/execution";
import type {
  DebateResultPayload,
  DebateRoundDecisionRequiredPayload,
  DebateRoundDecisionResolvedPayload,
  DebateRoundPayload,
  DebateRoundStartedPayload,
  RunContextPayload,
  RunPlanPayload,
  RunStartedPayload,
  SSEEvent,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@/types/events";
import {
  growCaptainContext,
  isCaptainRun,
  setCaptainRunId,
} from "../captainContext";
import { flushPendingContent } from "../contentBuffer";
import { execMessageId } from "../helpers";
import type { DispatchContext } from "../types";

function recordFrame(event: SSEEvent, conversationId: string): void {
  const mid = execMessageId(conversationId);
  const frame = frameFromEvent(event);
  if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
}

export function handleExecutionEvent(
  event: SSEEvent,
  ctx: DispatchContext,
): boolean {
  const { conversationId } = ctx;

  switch (event.type) {
    case "run_plan": {
      const payload = event.payload as RunPlanPayload;
      const mid = execMessageId(conversationId);
      if (!mid) return true;
      useExecutionStore.getState().ingestPlan(planFromRunPlan(payload), mid);
      if (
        payload.plan_type === "multi_agent" ||
        payload.plan_type === "debate"
      ) {
        // Flush any rAF-buffered content FIRST so it lands as content step(s) BEFORE the
        // `team` marker — the collaboration graph slots after the CEO's intro line, not
        // above it (协作图时间线落点; matches the conformance golden's [content, team] order).
        flushPendingContent(conversationId);
        useConversationStore
          .getState()
          .setLastAssistantExecutionId(payload.execution_id, conversationId);
      }
      return true;
    }
    case "run_started": {
      const p = event.payload as RunStartedPayload;
      if (p.kind === "captain") setCaptainRunId(conversationId, p.run_id);
      recordFrame(event, conversationId);
      return true;
    }
    case "run_context": {
      const p = event.payload as RunContextPayload;
      if (isCaptainRun(conversationId, p.run_id)) {
        const grown = growCaptainContext(conversationId, p.blocks);
        useConversationStore
          .getState()
          .setCaptainContext(grown, conversationId);
        return true;
      }
      recordFrame(event, conversationId);
      return true;
    }
    case "run_output_delta":
    // 交付前核验回炉 (finish_guard) 的 worker 对偶: run_output_reset 清这个 worker 已流式累积
    // 的草稿产出（content_reset 之于 CEO 气泡），重写版从干净态重累积。Folds via the same frame
    // path (projectExecution clears the agent's outputChunks); transport-only, not journaled.
    case "run_output_reset":
    case "run_reasoning_delta":
    case "run_tool_progress":
    case "run_completed":
    case "run_failed":
    case "run_progress":
    // 调度埋点量化 (深层诊断指标): the WaveScheduler snapshot folds onto Execution.batches via
    // the same frame path (journaled → replays on reload); shown only in 诊断模式 (run detail).
    case "batch_metrics":
    // 「计划已调整」轻痕迹 (设计 §7.2): a NON-interrupting trace — the CEO re-bound / re-steered
    // paused nodes via replan. Folds onto the runs' `revised` via the same frame path (no
    // conversation-store gate); journaled, so it replays on reload.
    case "plan_revised":
    case "run_escalation":
    // 阻塞式求决策: a worker SUSPENDED on a blocking escalate (escalation_required) then settled
    // (escalation_resolved). Both fold onto the run's escalations via the same frame path
    // (projectExecution appends `pending` / flips `resolved`|`timeout`), driving the bubble's
    // EscalationCard + the node badge. UNLIKE the gates (approval / plan_review) they do NOT pause
    // the turn — siblings keep running — so there is no conversation-store card, just the journaled
    // frame; both are journaled, so the exchange replays inline on reload.
    case "escalation_required":
    case "escalation_resolved":
    // 团队便签墙 (§2.2 通): a worker broadcast a one-line decision / heads-up to its
    // concurrent siblings. Turn-level (folds onto Execution.teamNotes via the same frame
    // path, not onto a node); journaled, so it replays on reload. Fire-and-forget — it never
    // pauses the turn (no conversation-store card), just the journaled frame.
    case "team_note_posted": {
      recordFrame(event, conversationId);
      return true;
    }
    case "tool_use_start": {
      recordFrame(event, conversationId);
      flushPendingContent(conversationId);
      useConversationStore
        .getState()
        .addProcessTool(event.payload as ToolUseStartPayload, conversationId);
      return true;
    }
    case "tool_use_end": {
      recordFrame(event, conversationId);
      flushPendingContent(conversationId);
      useConversationStore
        .getState()
        .endProcessTool(event.payload as ToolUseEndPayload, conversationId);
      return true;
    }
    case "debate_result": {
      const mid = execMessageId(conversationId);
      if (mid)
        useExecutionStore
          .getState()
          .recordDebateResult(event.payload as DebateResultPayload, mid);
      return true;
    }
    case "debate_round_started": {
      const mid = execMessageId(conversationId);
      if (mid) {
        const p = event.payload as DebateRoundStartedPayload;
        useExecutionStore.getState().recordDebateRound(
          {
            round_no: p.round_no,
            focus: p.focus,
            summary: "",
            verdict: null,
            sides: [],
            clashes: [],
          },
          mid,
        );
      }
      return true;
    }
    case "debate_round": {
      const mid = execMessageId(conversationId);
      if (mid) {
        const p = event.payload as DebateRoundPayload;
        useExecutionStore.getState().recordDebateRound(
          {
            round_no: p.round_no,
            focus: p.focus,
            summary: p.summary,
            verdict: p.verdict,
            sides: p.sides,
            clashes: p.clashes,
          },
          mid,
        );
      }
      return true;
    }
    // 交互式逐轮辩论 (opt-in, §逐轮交互): the Moderator paused at a round boundary for the user
    // to steer (continue / 加角度 / conclude). Append a `pending` decision card; its resolved
    // twin settles it. Transport-only (not journaled) — a desktop-live card, like debate_round.
    case "debate_round_decision_required": {
      const mid = execMessageId(conversationId);
      if (mid) {
        const p = event.payload as DebateRoundDecisionRequiredPayload;
        useExecutionStore.getState().recordDebateDecision(
          {
            kind: "required",
            id: p.decision_id,
            moderatorRunId: p.moderator_run_id,
            roundNo: p.round_no,
            focus: p.focus,
            summary: p.summary,
            converged: p.converged,
            rationale: p.rationale,
          },
          mid,
        );
      }
      return true;
    }
    case "debate_round_decision_resolved": {
      const mid = execMessageId(conversationId);
      if (mid) {
        const p = event.payload as DebateRoundDecisionResolvedPayload;
        useExecutionStore.getState().recordDebateDecision(
          {
            kind: "resolved",
            id: p.decision_id,
            decision: p.decision,
            focus: p.focus,
          },
          mid,
        );
      }
      return true;
    }
    default:
      return false;
  }
}
