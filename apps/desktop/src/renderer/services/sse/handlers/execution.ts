import { useConversationStore } from "@/stores/conversation";
import {
  frameFromEvent,
  planFromRunPlan,
  useExecutionStore,
} from "@/stores/execution";
import type {
  DebateResultPayload,
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
    case "run_reasoning_delta":
    case "run_tool_progress":
    case "run_completed":
    case "run_failed":
    case "run_progress":
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
    case "escalation_resolved": {
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
    default:
      return false;
  }
}
