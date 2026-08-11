import { dispatchSSEEvent, flushPendingContent } from "@/services/sse/dispatch";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import type { SSEEvent } from "@/types/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CID = "conv-inj-order";

function emit(ev: Omit<SSEEvent, "timestamp">): void {
  dispatchSSEEvent({ ...ev, timestamp: "" } as SSEEvent, {
    conversationId: CID,
    source: "server",
  });
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queueMicrotask(() => cb(0));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().setTurnPhase("streaming", CID);
});

afterEach(() => {
  flushPendingContent(CID);
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
  vi.unstubAllGlobals();
});

describe("user_interjection process marker order", () => {
  it("pins marker between team and later content (solo coordinate shape)", () => {
    emit({
      type: "message_start",
      payload: { message_id: "m1", conversation_id: CID },
    });
    emit({ type: "content_delta", payload: { delta: "我派一名工程师去做。" } });
    emit({
      type: "tool_use_start",
      payload: {
        tool_call_id: "dc1",
        tool_name: "delegate",
        arguments: {
          tasks: [{ role: "工程师", task: "实现功能" }],
          coordinate: true,
        },
      },
    });
    emit({
      type: "run_plan",
      payload: {
        execution_id: "exec1",
        plan_type: "multi_agent",
        task_summary: "单人协调",
        agents: [{ id: "w1", role: "工程师", thinking: true }],
        runs: [{ id: "r1", agent_id: "w1", task: "实现功能", depends_on: [] }],
      },
    });
    emit({
      type: "tool_use_end",
      payload: {
        tool_call_id: "dc1",
        tool_name: "delegate",
        status: "success",
        result: "ok",
      },
    });
    emit({
      type: "user_interjection",
      payload: {
        interjection_id: "inj-solo-stop",
        execution_id: "exec1",
        content: "把它停止",
        status: "received",
      },
    });
    emit({
      type: "content_delta",
      payload: { delta: "收到，正在停止这名工程师。" },
    });
    emit({
      type: "tool_use_start",
      payload: {
        tool_call_id: "cw1",
        tool_name: "cancel_worker",
        arguments: { run_id: "r1" },
      },
    });
    emit({
      type: "tool_use_end",
      payload: {
        tool_call_id: "cw1",
        tool_name: "cancel_worker",
        status: "success",
        result: "cancelled",
      },
    });
    emit({
      type: "content_delta",
      payload: { delta: "已按你的要求停下。" },
    });
    flushPendingContent(CID);

    const assistant = getRuntime(CID).messages.find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.process?.map((s) => s.kind)).toEqual([
      "content",
      "team",
      "user_interjection",
      "content",
      "tool",
      "content",
    ]);
  });
});
