/**
 * Step 5 regression: background writers update the *target* conversation bucket
 * without switching currentConversationId (no patchActive / forced switch).
 */
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import { beforeEach, describe, expect, it } from "vitest";
import { finalizeGeneratingForPausedConversation } from "../turns/helpers";
import { projectPausedRuns } from "../turns/projectPausedRuns";
import { markGhostInterrupted } from "../turns/recovery";

const TARGET = "conv-target-bg";
const OTHER = "conv-other-open";

const store = () => useConversationStore.getState();

function seedTargetAssistant(over: {
  id?: string;
  status?: "running" | "incomplete";
  finishReason?: string;
  isStreaming?: boolean;
  isGenerating?: boolean;
}): void {
  // Materialize target slice while OTHER is (or will be) open.
  store().addMessage(
    {
      id: "u1",
      role: "user",
      content: "q",
      createdAt: "2026-01-01T00:00:00Z",
      executionId: null,
      isStreaming: false,
    },
    TARGET,
  );
  store().addMessage(
    {
      id: over.id ?? "a1",
      role: "assistant",
      content: "partial",
      createdAt: "2026-01-01T00:00:01Z",
      executionId: null,
      isStreaming: over.isStreaming ?? true,
      status: over.status ?? "running",
      serverMessageId: over.id ?? "a1",
      ...(over.finishReason ? { finishReason: over.finishReason } : {}),
    },
    TARGET,
  );
  if (over.isGenerating) {
    store().setGenerating(true, TARGET);
  }
}

beforeEach(() => {
  useConversationStore.setState({
    currentConversationId: null,
    byId: {},
    sliceLruOrder: [],
  });
  useExecutionStore.setState({ byId: {} });
  usePausedTurnStore.getState().clear();
});

describe("background writes target bucket (step 5)", () => {
  it("projectPausedRuns writes target slice and does not switch conversation", () => {
    store().switchConversation(OTHER);
    store().addMessage(
      {
        id: "other-u",
        role: "user",
        content: "other",
        createdAt: "2026-01-01T00:00:00Z",
        executionId: null,
        isStreaming: false,
      },
      OTHER,
    );
    seedTargetAssistant({
      id: "a1",
      isStreaming: false,
      status: "incomplete",
      finishReason: "paused",
    });

    expect(store().currentConversationId).toBe(OTHER);

    projectPausedRuns(TARGET, {
      a1: {
        events: [
          {
            type: "run_plan",
            payload: {
              execution_id: "exec-bg",
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
        process: [{ kind: "team", execution_id: "exec-bg" }],
      },
    });

    expect(store().currentConversationId).toBe(OTHER);
    const msg = getRuntime(TARGET).messages.find((m) => m.id === "a1");
    expect(msg?.executionId).toBe("exec-bg");
    expect(msg?.runs?.events?.length).toBeGreaterThan(0);
    expect(getRuntime(OTHER).messages[0]?.id).toBe("other-u");
  });

  it("markGhostInterrupted stamps target assistant without switching", () => {
    store().switchConversation(OTHER);
    seedTargetAssistant({
      id: "a-ghost",
      isStreaming: true,
      status: "running",
    });

    expect(store().currentConversationId).toBe(OTHER);
    markGhostInterrupted(TARGET);

    expect(store().currentConversationId).toBe(OTHER);
    const msg = getRuntime(TARGET).messages.find((m) => m.id === "a-ghost");
    expect(msg?.finishReason).toBe("interrupted");
    expect(msg?.status).toBe("incomplete");
    expect(msg?.isStreaming).toBe(false);
    expect(getRuntime(TARGET).isGenerating).toBe(false);
  });

  it("finalizeGeneratingForPausedConversation stamps target when another chat is open", () => {
    store().switchConversation(OTHER);
    seedTargetAssistant({
      id: "a-pause",
      isStreaming: true,
      isGenerating: true,
    });

    expect(store().currentConversationId).toBe(OTHER);
    finalizeGeneratingForPausedConversation(TARGET, { force: true });

    expect(store().currentConversationId).toBe(OTHER);
    const msg = getRuntime(TARGET).messages.find((m) => m.id === "a-pause");
    expect(msg?.finishReason).toBe("paused");
    expect(msg?.isStreaming).toBe(false);
    expect(getRuntime(TARGET).isGenerating).toBe(false);
  });

  it("updateMessage / focusMessage patch the named conversation, not active", () => {
    store().switchConversation(OTHER);
    store().addMessage(
      {
        id: "other-a",
        role: "assistant",
        content: "open",
        createdAt: "2026-01-01T00:00:00Z",
        executionId: null,
        isStreaming: false,
      },
      OTHER,
    );
    seedTargetAssistant({
      id: "a-patch",
      isStreaming: false,
      status: "incomplete",
    });

    store().updateMessage("a-patch", { content: "from-bg" }, TARGET);
    store().focusMessage("a-patch", TARGET);

    expect(store().currentConversationId).toBe(OTHER);
    expect(
      getRuntime(TARGET).messages.find((m) => m.id === "a-patch")?.content,
    ).toBe("from-bg");
    expect(getRuntime(TARGET).messageFocus?.id).toBe("a-patch");
    expect(getRuntime(OTHER).messages[0]?.content).toBe("open");
    expect(getRuntime(OTHER).messageFocus).toBeNull();
  });

  it("sidecar resume stamp writes target assistant without switching", () => {
    // Mirrors sidecarAttach resume branch: flip paused assistant back to streaming
    // under the server message id while another chat is open.
    store().switchConversation(OTHER);
    const clientId = "client-bubble";
    const serverId = "server-resume-msg";
    store().addMessage(
      {
        id: clientId,
        role: "assistant",
        content: "pre-pause",
        createdAt: "2026-01-01T00:00:01Z",
        executionId: null,
        isStreaming: false,
        status: "incomplete",
        finishReason: "paused",
        serverMessageId: serverId,
      },
      TARGET,
    );

    expect(store().currentConversationId).toBe(OTHER);
    store().updateMessage(
      clientId,
      {
        isStreaming: true,
        status: "running",
      },
      TARGET,
    );

    expect(store().currentConversationId).toBe(OTHER);
    const msg = getRuntime(TARGET).messages.find((m) => m.id === clientId);
    expect(msg?.isStreaming).toBe(true);
    expect(msg?.status).toBe("running");
    expect(msg?.serverMessageId).toBe(serverId);
  });
});
