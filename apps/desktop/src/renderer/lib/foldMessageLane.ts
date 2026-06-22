// CEO 气泡「消息道」标量 fold — content / reasoning / process / citations。
// 生产 store（conversation.ts）与协议巡检（conformanceFold.ts）共用，与
// processTimeline.ts 一起保证 live / reload / golden 三路径同源。

import type {
  Citation,
  ProcessStep,
  ToolUseEndPayload,
  ToolUseStartPayload,
} from "@/types/events";
import {
  appendContentStep,
  appendReasoningStep,
  appendToolStep,
  dropTrailingContentSteps,
  resolveToolStep,
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
    process: dropTrailingContentSteps(state.process),
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

export function foldCitations(
  state: MessageLaneState,
  citations: Citation[],
): MessageLaneState {
  return { ...state, citations };
}
