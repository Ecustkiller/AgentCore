/**
 * projectPausedRuns: fill assistant.runs from local pause-frame display_runs.
 */
import { teamHasStartedRuns } from "@/components/chat/debatePreviewPlacement";
import {
  assistantProjectionId,
  getRuntime,
  useConversationStore,
} from "@/stores/conversation";
import { projectRuntime, useExecutionStore } from "@/stores/execution";
import { beforeEach, describe, expect, it } from "vitest";
import { projectPausedRuns } from "../turns/projectPausedRuns";

const CID = "conv-paused-runs";

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
});

describe("projectPausedRuns", () => {
  it("hydrates execution + stamps executionId when message.runs is empty", () => {
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
        content: "摸底已齐",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: false,
        serverMessageId: "a1",
        finishReason: "paused",
      },
      CID,
    );

    projectPausedRuns(CID, {
      a1: {
        events: [
          {
            type: "run_plan",
            payload: {
              execution_id: "exec-1",
              plan_type: "multi_agent",
              task_summary: "摸底",
              agents: [{ id: "agent-1", role: "代码排查员" }],
              runs: [
                {
                  id: "w1",
                  agent_id: "agent-1",
                  task: "查 BUG",
                  depends_on: [],
                  kind: "worker",
                },
              ],
            },
            timestamp: "t0",
          },
          {
            type: "run_started",
            payload: { run_id: "w1" },
            timestamp: "t1",
          },
        ],
        finish_reason: "paused",
        process: [{ kind: "team", execution_id: "exec-1" }],
      },
    });

    const msg = getRuntime(CID).messages.find((m) => m.id === "a1");
    expect(msg?.executionId).toBe("exec-1");
    expect(msg?.runs?.events?.length).toBeGreaterThan(0);
    expect(msg?.finishReason).toBe("paused");
    expect(useExecutionStore.getState().byId.a1?.plan).toBeTruthy();
  });

  it("lands plan on assistantProjectionId when client id ≠ serverMessageId", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    const clientId = "client-bubble-uuid";
    const serverId = "server-turn-msg";
    store.addMessage(
      {
        id: clientId,
        role: "assistant",
        content: "摸底已齐",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: false,
        serverMessageId: serverId,
        finishReason: "paused",
      },
      CID,
    );

    projectPausedRuns(CID, {
      [serverId]: {
        events: [
          {
            type: "run_plan",
            payload: {
              execution_id: "exec-proj",
              plan_type: "multi_agent",
              task_summary: "摸底",
              agents: [{ id: "agent-1", role: "代码排查员" }],
              runs: [
                {
                  id: "w1",
                  agent_id: "agent-1",
                  task: "查 BUG",
                  depends_on: [],
                  kind: "worker",
                },
              ],
            },
            timestamp: "t0",
          },
          {
            type: "run_started",
            payload: { run_id: "w1" },
            timestamp: "t1",
          },
        ],
        finish_reason: "paused",
        process: [{ kind: "team", execution_id: "exec-proj" }],
      },
    });

    const msg = getRuntime(CID).messages.find((m) => m.id === clientId);
    expect(msg).toBeTruthy();
    if (!msg) throw new Error("expected projected message");
    expect(assistantProjectionId(msg)).toBe(serverId);
    expect(msg.executionId).toBe("exec-proj");
    expect(msg.runs?.events?.length).toBeGreaterThan(0);

    const byId = useExecutionStore.getState().byId;
    // Projection key (InlineTeamGraph / SSE) — not the client bubble id.
    expect(byId[serverId]?.plan).toBeTruthy();
    expect(byId[clientId]?.plan).toBeUndefined();
    // Graph gate reads the same projected runs InlineTeamGraph would.
    const runtime = byId[serverId];
    expect(runtime).toBeTruthy();
    if (!runtime) throw new Error("expected execution runtime");
    const projected = projectRuntime(runtime);
    expect(projected).toBeTruthy();
    if (!projected) throw new Error("expected projected runtime");
    expect(teamHasStartedRuns(projected.runs)).toBe(true);
  });

  it("does not shrink an already-richer journal", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(
      {
        id: "a1",
        role: "assistant",
        content: "x",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: "exec-rich",
        isStreaming: false,
        serverMessageId: "a1",
        runs: {
          events: [
            {
              type: "run_plan",
              payload: { execution_id: "exec-rich" },
              timestamp: "t0",
            },
            {
              type: "run_started",
              payload: { run_id: "w1" },
              timestamp: "t1",
            },
            {
              type: "run_completed",
              payload: { run_id: "w1" },
              timestamp: "t2",
            },
          ],
          finishReason: "paused",
        },
      },
      CID,
    );

    projectPausedRuns(CID, {
      a1: {
        events: [
          {
            type: "run_plan",
            payload: { execution_id: "exec-thin" },
            timestamp: "t0",
          },
        ],
        finish_reason: "paused",
      },
    });

    const msg = getRuntime(CID).messages.find((m) => m.id === "a1");
    expect(msg?.executionId).toBe("exec-rich");
    expect(msg?.runs?.events?.length).toBe(3);
  });
});
