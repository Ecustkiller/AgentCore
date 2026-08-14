/**
 * B5 orphan empty-bubble settle (1a69f9dc · 方案 A).
 */
import { useConversationStore } from "@/stores/conversation";
import {
  type ExecutionPlan,
  type RunFrame,
  useExecutionStore,
} from "@/stores/execution";
import { beforeEach, describe, expect, it } from "vitest";
import { settleOrphanEmptyAssistants } from "../turns/recovery";

const CID = "conv-orphan-empty";

const plan: ExecutionPlan = {
  id: "exec-orphan",
  planType: "multi_agent",
  taskSummary: "t",
  agents: [{ id: "w1", role: "研究员" }],
  runs: [{ id: "r1", agentId: "w1", task: "调研", dependsOn: [] }],
};

function started(): RunFrame {
  return {
    t: 1,
    kind: "run_started",
    agentId: "w1",
    runId: "r1",
    parentRunId: null,
    runKind: "agent",
    continuesRunId: null,
  };
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
});

describe("settleOrphanEmptyAssistants", () => {
  it("rewrites streaming empty assistant to interrupted", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "u1",
        role: "user",
        content: "q",
        createdAt: "2026-01-01T00:00:00Z",
        executionId: null,
        isStreaming: false,
      },
      CID,
    );
    store.addMessage(
      {
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: true,
        status: "running",
      },
      CID,
    );

    settleOrphanEmptyAssistants(CID);

    const a = useConversationStore
      .getState()
      .byId[CID].messages.find((m) => m.id === "a1");
    expect(a?.isStreaming).toBe(false);
    expect(a?.status).toBe("incomplete");
    expect(a?.finishReason).toBe("interrupted");
  });

  it("leaves cancelled empty alone (synthetic cancelled face)", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "a-cancel",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: false,
        status: "incomplete",
        finishReason: "cancelled",
      },
      CID,
    );

    settleOrphanEmptyAssistants(CID);

    const a = useConversationStore
      .getState()
      .byId[CID].messages.find((m) => m.id === "a-cancel");
    expect(a?.finishReason).toBe("cancelled");
  });

  it("does not touch assistants with body", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "a-body",
        role: "assistant",
        content: "partial answer",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: true,
        status: "running",
      },
      CID,
    );

    settleOrphanEmptyAssistants(CID);

    const a = useConversationStore
      .getState()
      .byId[CID].messages.find((m) => m.id === "a-body");
    expect(a?.isStreaming).toBe(true);
    expect(a?.finishReason).toBeUndefined();
  });

  it("finalizes live execution to cancelled instead of clearing projection", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "a-graph",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: "exec-orphan",
        isStreaming: true,
        status: "running",
      },
      CID,
    );
    const exec = useExecutionStore.getState();
    exec.startExecution(plan, "a-graph");
    exec.recordFrame(started(), "a-graph");

    settleOrphanEmptyAssistants(CID);

    const rt = useExecutionStore.getState().byId["a-graph"];
    expect(rt?.plan).toBeTruthy();
    expect(rt?.status).toBe("cancelled");
    expect(rt?.frames.length).toBe(1);
  });

  it("leaves paused+running empty bubble alone (cold-load latch)", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "a-paused",
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: false,
        status: "running",
        finishReason: "paused",
      },
      CID,
    );

    settleOrphanEmptyAssistants(CID);

    const a = useConversationStore
      .getState()
      .byId[CID].messages.find((m) => m.id === "a-paused");
    expect(a?.status).toBe("running");
    expect(a?.finishReason).toBe("paused");
    expect(a?.isStreaming).toBe(false);
  });
});
