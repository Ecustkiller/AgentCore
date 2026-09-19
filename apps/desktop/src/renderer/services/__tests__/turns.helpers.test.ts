import {
  beginTurnPreflight,
  enterTurnStreaming,
  getRuntime,
  getTurnPhase,
  useConversationStore,
} from "@/stores/conversation";
import {
  type ExecutionPlan,
  execRuntime,
  useExecutionStore,
} from "@/stores/execution";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitLocalUserStop,
  finalizeGeneratingIfNeeded,
  finalizeHonestStopAbort,
  isInterruptAbort,
} from "../turns/helpers";

const CID = "conv-honest-stop-abort";

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: CID, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useExecutionStore.setState({ byId: {} });
});

describe("finalizeHonestStopAbort", () => {
  it("stopping + generating → stopped 且清 isGenerating，盖 finishReason=cancelled", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    const mid = useConversationStore.getState().createAssistantMessage(CID);
    useConversationStore.getState().setTurnPhase("stopping", CID);
    expect(getTurnPhase(CID)).toBe("stopping");
    expect(getRuntime(CID).isGenerating).toBe(true);

    finalizeHonestStopAbort(CID);

    expect(getTurnPhase(CID)).toBe("stopped");
    expect(getRuntime(CID).isGenerating).toBe(false);
    const tail = getRuntime(CID).messages.find((m) => m.id === mid);
    expect(tail?.isStreaming).toBe(false);
    expect(tail?.finishReason).toBe("cancelled");
  });

  it("非 stopping 只清 generating（对齐 finalizeGeneratingIfNeeded）", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    const mid = useConversationStore.getState().createAssistantMessage(CID);
    expect(getTurnPhase(CID)).toBe("streaming");

    finalizeHonestStopAbort(CID);

    expect(getTurnPhase(CID)).toBe("streaming");
    expect(getRuntime(CID).isGenerating).toBe(false);
    const tail = getRuntime(CID).messages.find((m) => m.id === mid);
    expect(tail?.finishReason).toBeUndefined();
  });

  it("idle 无 generating 为 no-op", () => {
    finalizeHonestStopAbort(CID);
    expect(getTurnPhase(CID)).toBe("idle");
    expect(getRuntime(CID).isGenerating).toBe(false);
  });

  it("不覆盖已有 interrupted / paused", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    const mid = useConversationStore.getState().createAssistantMessage(CID);
    if (!mid) throw new Error("expected assistant");
    useConversationStore.getState().updateMessage(mid, {
      finishReason: "interrupted",
      isStreaming: false,
    });
    useConversationStore.getState().setTurnPhase("stopping", CID);

    finalizeHonestStopAbort(CID);

    expect(
      getRuntime(CID).messages.find((m) => m.id === mid)?.finishReason,
    ).toBe("interrupted");
  });

  it("Interrupted Abort 即使 stopping 也不盖 cancelled；无 finishReason 则盖 interrupted", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    const mid = useConversationStore.getState().createAssistantMessage(CID);
    useConversationStore.getState().setTurnPhase("stopping", CID);

    const err = new DOMException("Interrupted", "AbortError");
    expect(isInterruptAbort(err)).toBe(true);
    finalizeHonestStopAbort(CID, err);

    expect(getTurnPhase(CID)).toBe("stopped");
    const tail = getRuntime(CID).messages.find((m) => m.id === mid);
    expect(tail?.finishReason).toBe("interrupted");
    expect(tail?.finishReason).not.toBe("cancelled");
  });

  it("Interrupted Abort 不覆盖已有 finishReason", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    const mid = useConversationStore.getState().createAssistantMessage(CID);
    if (!mid) throw new Error("expected assistant");
    useConversationStore.getState().updateMessage(mid, {
      finishReason: "end_turn",
      isStreaming: false,
    });

    finalizeHonestStopAbort(CID, new DOMException("Interrupted", "AbortError"));

    expect(
      getRuntime(CID).messages.find((m) => m.id === mid)?.finishReason,
    ).toBe("end_turn");
  });

  it("Interrupted Abort 在非 stopping 也给缺席尾巴盖 interrupted", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    const mid = useConversationStore.getState().createAssistantMessage(CID);

    finalizeHonestStopAbort(CID, new DOMException("Interrupted", "AbortError"));

    expect(getTurnPhase(CID)).toBe("streaming");
    expect(
      getRuntime(CID).messages.find((m) => m.id === mid)?.finishReason,
    ).toBe("interrupted");
  });
});

describe("finalizeGeneratingIfNeeded", () => {
  it("generating 时 finalizeLastMessage", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    useConversationStore.getState().createAssistantMessage(CID);
    finalizeGeneratingIfNeeded(CID);
    expect(getRuntime(CID).isGenerating).toBe(false);
  });
});

describe("commitLocalUserStop", () => {
  const plan: ExecutionPlan = {
    id: "exec-local-stop",
    planType: "multi_agent",
    taskSummary: "并行调研",
    agents: [{ id: "w1", role: "研究员" }],
    runs: [{ id: "r1", agentId: "w1", task: "调研", dependsOn: [] }],
  };

  it("冻图 cancelled、关生成锁、盖 finishReason", () => {
    beginTurnPreflight(CID);
    enterTurnStreaming(CID);
    const mid = useConversationStore.getState().createAssistantMessage(CID);
    if (!mid) throw new Error("expected assistant");
    useExecutionStore.getState().startExecution(plan, mid);
    useExecutionStore.getState().recordFrame(
      {
        t: 1,
        kind: "run_started",
        runId: "r1",
        agentId: "w1",
        parentRunId: null,
        runKind: "agent",
        continuesRunId: null,
      },
      mid,
    );

    commitLocalUserStop(CID);

    expect(getRuntime(CID).isGenerating).toBe(false);
    expect(
      getRuntime(CID).messages.find((m) => m.id === mid)?.finishReason,
    ).toBe("cancelled");
    expect(execRuntime(useExecutionStore.getState(), mid).status).toBe(
      "cancelled",
    );
  });
});
