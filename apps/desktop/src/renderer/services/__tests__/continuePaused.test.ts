import { StreamError } from "@/lib/errors";
import { continueConversation } from "@/services/streamConversation";
import { continuePausedTurn } from "@/services/turns/continuePaused";
import { rejoinLiveTurn } from "@/services/turns/recovery";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/streamConversation", () => ({
  continueConversation: vi.fn(),
}));
vi.mock("@/services/turns/recovery", () => ({
  rejoinLiveTurn: vi.fn(),
}));

const CID = "conv-continue-paused";
const MID = "msg-continue-paused";

const TEAM_PLAN = {
  id: "exec-1",
  planType: "multi_agent" as const,
  taskSummary: "t",
  agents: [{ id: "w1", role: "r" }],
  runs: [{ id: "r1", agentId: "w1", task: "t", dependsOn: [] }],
};

function seedPausedAssistant(opts?: { withTeam?: boolean }): string {
  const conv = useConversationStore.getState();
  conv.switchConversation(CID);
  conv.addMessage({
    id: "u1",
    role: "user",
    content: "go",
    createdAt: "",
    executionId: null,
    isStreaming: false,
  });
  const bubbleId = conv.createAssistantMessage(CID);
  conv.setServerMessageIdOnLastMessage(MID, CID);
  conv.finalizeLastMessage(CID);
  conv.updateMessage(
    bubbleId,
    {
      content: "半成品答案",
      finishReason: "paused",
      outcome: "paused",
    },
    CID,
  );
  conv.setTurnPhase("completed", CID);
  if (opts?.withTeam) {
    useExecutionStore.getState().startExecution(TEAM_PLAN, MID);
    useExecutionStore.getState().setStatus("paused", MID);
    useExecutionStore.getState().setAttestedOutcome("paused", MID);
  }
  return bubbleId;
}

function pausedAssistant() {
  return getRuntime(CID).messages.find((m) => m.role === "assistant");
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
  vi.mocked(continueConversation).mockReset();
  vi.mocked(continueConversation).mockResolvedValue(undefined);
  vi.mocked(rejoinLiveTurn).mockReset();
  vi.mocked(rejoinLiveTurn).mockResolvedValue(false);
});

describe("continuePausedTurn", () => {
  it("POSTs continue on the stamped assistant, not a new user turn", async () => {
    seedPausedAssistant({ withTeam: true });

    await continuePausedTurn({ conversationId: CID, messageId: MID });

    expect(continueConversation).toHaveBeenCalledWith({
      conversationId: CID,
      messageId: MID,
      signal: expect.any(AbortSignal),
    });
    expect(
      getRuntime(CID).messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
    expect(useExecutionStore.getState().byId[MID]?.status).toBe("running");
  });

  it("abort restores the solo paused continue face", async () => {
    seedPausedAssistant();
    vi.mocked(continueConversation).mockRejectedValueOnce(
      new DOMException("Aborted", "AbortError"),
    );

    await continuePausedTurn({ conversationId: CID, messageId: MID });

    const assistant = pausedAssistant();
    expect(assistant?.isStreaming).toBe(false);
    expect(assistant?.outcome).toBe("paused");
    expect(assistant?.finishReason).toBe("paused");
    expect(getRuntime(CID).isGenerating).toBe(false);
    expect(getRuntime(CID).turnPhase).toBe("completed");
  });

  it("transport-drop rejoin failure restores the solo paused continue face", async () => {
    seedPausedAssistant();
    vi.mocked(continueConversation).mockRejectedValueOnce(
      new StreamError("network"),
    );
    vi.mocked(rejoinLiveTurn).mockResolvedValueOnce(false);

    await continuePausedTurn({ conversationId: CID, messageId: MID });

    const assistant = pausedAssistant();
    expect(assistant?.isStreaming).toBe(false);
    expect(assistant?.outcome).toBe("paused");
    expect(assistant?.finishReason).toBe("paused");
    expect(getRuntime(CID).isGenerating).toBe(false);
    expect(getRuntime(CID).turnPhase).toBe("completed");
    expect(rejoinLiveTurn).toHaveBeenCalledWith(CID);
  });

  it("transport-drop rejoin success keeps the resumed stream", async () => {
    seedPausedAssistant();
    vi.mocked(continueConversation).mockRejectedValueOnce(
      new StreamError("network"),
    );
    vi.mocked(rejoinLiveTurn).mockResolvedValueOnce(true);

    await continuePausedTurn({ conversationId: CID, messageId: MID });

    const assistant = pausedAssistant();
    expect(assistant?.isStreaming).toBe(true);
    expect(assistant?.outcome).toBeUndefined();
    expect(getRuntime(CID).isGenerating).toBe(true);
  });

  it("generic error restores paused face and team slot status", async () => {
    seedPausedAssistant({ withTeam: true });
    vi.mocked(continueConversation).mockRejectedValueOnce(
      new StreamError("http", 500),
    );

    await continuePausedTurn({ conversationId: CID, messageId: MID });

    const assistant = pausedAssistant();
    expect(assistant?.isStreaming).toBe(false);
    expect(assistant?.outcome).toBe("paused");
    expect(assistant?.finishReason).toBe("paused");
    expect(getRuntime(CID).isGenerating).toBe(false);
    expect(useExecutionStore.getState().byId[MID]?.status).toBe("paused");
    expect(useExecutionStore.getState().byId[MID]?.attestedOutcome).toBe(
      "paused",
    );
  });
});
