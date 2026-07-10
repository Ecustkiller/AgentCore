// CEO 气泡「消息道」标量 fold — content / reasoning / process / citations。
// 生产 store（conversation.ts）与协议巡检（conformanceFold.ts）共用，与
// processTimeline.ts 一起保证 live / reload / golden 三路径同源。

import type {
  Citation,
  ProcessStep,
  ToolUseEndPayload,
  ToolUseProgressPayload,
  ToolUseStartPayload,
} from "@/types/events";
import {
  appendAskStep,
  appendCheckpointStep,
  appendContentStep,
  appendPlanReviewStep,
  appendReasoningStep,
  appendReworkStep,
  appendTeamPreviewStep,
  appendTeamStep,
  appendToolStep,
  dropTrailingContentSteps,
  resolveToolStep,
  resolveToolStepPhase,
} from "./processTimeline";

export interface MessageLaneState {
  content: string;
  reasoning: string;
  process: ProcessStep[];
  citations: Citation[];
}

export function messageLaneFromMessage(msg: {
  content: string;
  reasoning?: string;
  process?: ProcessStep[];
  citations?: Citation[];
}): MessageLaneState {
  return {
    content: msg.content,
    reasoning: msg.reasoning ?? "",
    process: msg.process ?? [],
    citations: msg.citations ?? [],
  };
}

export function foldContentDelta(
  state: MessageLaneState,
  delta: string,
): MessageLaneState {
  const d = delta || "";
  if (!d) return state;
  return {
    ...state,
    content: state.content + d,
    process: appendContentStep(state.process, d),
  };
}

export function foldContentReset(state: MessageLaneState): MessageLaneState {
  return {
    ...state,
    content: "",
    process: appendReworkStep(dropTrailingContentSteps(state.process)),
  };
}

export function foldReasoningDelta(
  state: MessageLaneState,
  delta: string,
): MessageLaneState {
  const d = delta || "";
  if (!d) return state;
  return {
    ...state,
    reasoning: state.reasoning + d,
    process: appendReasoningStep(state.process, d),
  };
}

export function foldToolUseStart(
  state: MessageLaneState,
  payload: ToolUseStartPayload,
): MessageLaneState {
  const process = appendToolStep(state.process, payload);
  return process === state.process ? state : { ...state, process };
}

export function foldToolUseEnd(
  state: MessageLaneState,
  payload: ToolUseEndPayload,
): MessageLaneState {
  const process = resolveToolStep(state.process, payload);
  if (!process || process === state.process) return state;
  return { ...state, process };
}

/** 工具执行阶段进度 (联网搜索前端展示优化): stamp a running tool step's coarse `phase` from a
 * `tool_use_progress` event. LIVE-ONLY — this event never rides a journal / conformance vector,
 * so `conformanceFold` no-ops it and the golden stays phase-less; only the production stream
 * calls this. No-op (same state) when no running step matches. */
export function foldToolUsePhase(
  state: MessageLaneState,
  payload: ToolUseProgressPayload,
): MessageLaneState {
  const process = resolveToolStepPhase(state.process, payload);
  if (!process || process === state.process) return state;
  return { ...state, process };
}

export function foldCitations(
  state: MessageLaneState,
  citations: Citation[],
): MessageLaneState {
  return { ...state, citations };
}

/** Fold a `run_plan` into the timeline as a `team` marker (协作图时间线落点) — the FIRST
 * plan of an execution fixes the collaboration graph's slot; later same-id batches no-op. */
export function foldTeamMarker(
  state: MessageLaneState,
  executionId: string,
): MessageLaneState {
  const process = appendTeamStep(state.process, executionId);
  return process === state.process ? state : { ...state, process };
}

/** Fold a `checkpoint_required` into the timeline as a positional `checkpoint` marker.
 * Also absorbs same-round CEO prose into the card (mirrors backend ``content_reset`` on
 * a successful blocking ``ask_user``) so streamed text never duplicates the card. */
export function foldCheckpointMarker(
  state: MessageLaneState,
  checkpointId: string,
): MessageLaneState {
  const clearedProcess = dropTrailingContentSteps(state.process);
  const process = appendCheckpointStep(clearedProcess, checkpointId);
  if (
    process === state.process &&
    clearedProcess === state.process &&
    !state.content
  ) {
    return state;
  }
  return {
    ...state,
    content: "",
    process,
  };
}

/** Fold a `question_posted` into the timeline as a positional `ask` marker. */
export function foldAskMarker(
  state: MessageLaneState,
  askId: string,
): MessageLaneState {
  const process = appendAskStep(state.process, askId);
  return process === state.process ? state : { ...state, process };
}

/** Fold a `plan_review_required` into the timeline as a positional `plan_review` marker. */
export function foldPlanReviewMarker(
  state: MessageLaneState,
  checkpointId: string,
): MessageLaneState {
  const process = appendPlanReviewStep(state.process, checkpointId);
  return process === state.process ? state : { ...state, process };
}

/** Fold a `team_preview_required` into the timeline as a positional `team_preview` marker. */
export function foldTeamPreviewMarker(
  state: MessageLaneState,
  checkpointId: string,
): MessageLaneState {
  const process = appendTeamPreviewStep(state.process, checkpointId);
  return process === state.process ? state : { ...state, process };
}
