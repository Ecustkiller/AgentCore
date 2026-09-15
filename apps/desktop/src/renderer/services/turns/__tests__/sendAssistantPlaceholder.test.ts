import { logEvent } from "@/lib/log";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSendAssistantPlaceholder } from "../sendAssistantPlaceholder";

vi.mock("@/lib/log", () => ({
  logEvent: vi.fn(),
}));

const logMock = vi.mocked(logEvent);

const CID = "conv-send-placeholder";

function seedUser(id = "opt-u"): void {
  useConversationStore.getState().addMessage(
    {
      id,
      role: "user",
      content: "你好",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    },
    CID,
  );
}

beforeEach(() => {
  logMock.mockClear();
  useConversationStore.setState({ currentConversationId: CID, byId: {} });
});

describe("ensureSendAssistantPlaceholder", () => {
  it("reuses a clean streaming empty assistant (same id)", () => {
    seedUser();
    const painted = useConversationStore.getState().createAssistantMessage(CID);

    ensureSendAssistantPlaceholder(CID, "opt-u");

    const assistants = getRuntime(CID).messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.id).toBe(painted);
    expect(assistants[0]?.isStreaming).toBe(true);
    expect(getRuntime(CID).isGenerating).toBe(true);
    expect(logMock).toHaveBeenCalledWith("info", "send.assistant_placeholder", {
      conversation_id: CID,
      optimistic_user_id: "opt-u",
      assistant_id: painted,
      action: "reuse",
    });
  });

  it("revives an orphan-settled empty placeholder instead of minting a new id", () => {
    seedUser();
    const painted = useConversationStore.getState().createAssistantMessage(CID);
    useConversationStore
      .getState()
      .updateMessage(painted, { isStreaming: false }, CID);

    ensureSendAssistantPlaceholder(CID, "opt-u");

    const assistants = getRuntime(CID).messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.id).toBe(painted);
    expect(assistants[0]?.isStreaming).toBe(true);
    expect(logMock).toHaveBeenCalledWith(
      "info",
      "send.assistant_placeholder",
      expect.objectContaining({ action: "reuse", assistant_id: painted }),
    );
  });

  it("creates an assistant when the user bubble is last", () => {
    seedUser();

    ensureSendAssistantPlaceholder(CID, "opt-u");

    const msgs = getRuntime(CID).messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.isStreaming).toBe(true);
    expect(logMock).toHaveBeenCalledWith("info", "send.assistant_placeholder", {
      conversation_id: CID,
      optimistic_user_id: "opt-u",
      assistant_id: msgs[1]?.id,
      action: "mint",
    });
  });

  it("truncates a leftover with body and mints a fresh empty assistant", () => {
    seedUser();
    useConversationStore.getState().addMessage(
      {
        id: "stale-a",
        role: "assistant",
        content: "半截",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      },
      CID,
    );

    ensureSendAssistantPlaceholder(CID, "opt-u");

    const assistants = getRuntime(CID).messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.id).not.toBe("stale-a");
    expect(assistants[0]?.content).toBe("");
    expect(assistants[0]?.isStreaming).toBe(true);
    expect(logMock).toHaveBeenCalledWith(
      "info",
      "send.assistant_placeholder",
      expect.objectContaining({
        action: "mint",
        assistant_id: assistants[0]?.id,
      }),
    );
    expect(logMock.mock.calls[0]?.[2]).not.toMatchObject({
      assistant_id: "stale-a",
    });
  });
});
