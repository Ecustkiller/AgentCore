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
  ToolUseProgressPayload,
  ToolUseStartPayload,
} from "@/types/events";
import {
  growCaptainContext,
  isCaptainRun,
  setCaptainRunId,
} from "../captainContext";
import { flushPendingContent } from "../contentBuffer";
import { flushPendingFrames, queueFrame } from "../execFrameBuffer";
import { execMessageId } from "../helpers";
import type { DispatchContext } from "../types";

/** A structural (low-frequency) frame: flush any rAF-buffered hot frames FIRST so global
 * frame order is preserved, then append this one immediately. */
function recordFrameNow(event: SSEEvent, conversationId: string): void {
  flushPendingFrames(conversationId);
  const mid = execMessageId(conversationId);
  const frame = frameFromEvent(event);
  if (mid && frame) useExecutionStore.getState().recordFrame(frame, mid);
}

/** A high-frequency accumulate-only frame (run_*_delta / tool_progress / output_reset):
 * coalesce into the next animation frame ({@link queueFrame}) instead of a per-token store
 * write — the 白屏卡死 fix (逐 token → ≤60Hz). */
function queueFrameEvent(event: SSEEvent, conversationId: string): void {
  const frame = frameFromEvent(event);
  if (frame) queueFrame(conversationId, frame);
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
      recordFrameNow(event, conversationId);
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
      recordFrameNow(event, conversationId);
      return true;
    }
    // 高频纯累积帧 (流式性能，白屏卡死修复): rAF 合批，避免逐 token 全图重折叠 + 全消费者重
    // 渲染 (整条流 O(n²))。run_output_reset (交付前核验回炉 finish_guard 的 worker 对偶,
    // content_reset 之于 CEO 气泡: 清 worker 已流式累积的草稿产出、重写版从干净态重累积) 也走
    // 同一有序缓冲，故与它清理的 delta 天然保序。Folds via the same frame path; transport-only.
    case "run_output_delta":
    case "run_output_reset":
    case "run_reasoning_delta":
    case "run_tool_progress": {
      queueFrameEvent(event, conversationId);
      return true;
    }
    // 结构性帧 (低频): recordFrameNow 先 flush 高频缓冲以保帧顺序，再立即落。
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
      recordFrameNow(event, conversationId);
      return true;
    }
    case "tool_use_start": {
      recordFrameNow(event, conversationId);
      flushPendingContent(conversationId);
      useConversationStore
        .getState()
        .addProcessTool(event.payload as ToolUseStartPayload, conversationId);
      return true;
    }
    case "tool_use_end": {
      recordFrameNow(event, conversationId);
      flushPendingContent(conversationId);
      useConversationStore
        .getState()
        .endProcessTool(event.payload as ToolUseEndPayload, conversationId);
      return true;
    }
    // 工具执行阶段进度 (联网搜索前端展示优化): a running tool reported a coarse EXECUTION phase
    // (web_search → querying / queued / fallback). Transport-only liveliness — NOT journaled, so
    // no frame is recorded (a reloaded turn's tools are already resolved); it only stamps the live
    // running tool step's phase for the waiting UI.
    case "tool_use_progress": {
      useConversationStore
        .getState()
        .setProcessToolPhase(
          event.payload as ToolUseProgressPayload,
          conversationId,
        );
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
