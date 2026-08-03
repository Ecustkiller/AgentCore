import { useConversationStore } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import { usePausedTurnStore } from "@/stores/pausedTurns";
// @vitest-environment jsdom
/**
 * Live cold card authority = InteractionStore: team_preview_required with a
 * server stamp paints ResumePrompt without message_end → surfaceResume.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResumePrompt } from "../ResumePrompt";

vi.mock("@/services/interactionSubmit", () => ({
  submitInteraction: vi.fn().mockResolvedValue("ok"),
  submitInteractionFeedback: (result: "busy" | "orphaned") =>
    result === "orphaned" ? "确认已失效" : "请稍候再试",
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

const CID = "conv-live-ix";

afterEach(() => {
  cleanup();
  usePausedTurnStore.getState().clear();
  useInteractionStore.getState().clear();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

beforeEach(() => {
  usePausedTurnStore.getState().clear();
  useInteractionStore.getState().clear();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().addMessage({
    id: "u1",
    role: "user",
    content: "组团做定价",
    createdAt: "",
    executionId: null,
    isStreaming: false,
  });
  useConversationStore.getState().addMessage({
    id: "client-uuid",
    role: "assistant",
    content: "",
    createdAt: "",
    executionId: null,
    isStreaming: true,
  });
  useConversationStore
    .getState()
    .setServerMessageIdOnLastMessage("m-server-tp", CID);
});

describe("ResumePrompt · live InteractionStore authority", () => {
  it("team_preview_required with stamp paints without surfaceResume", () => {
    expect(usePausedTurnStore.getState().pending).toHaveLength(0);

    useInteractionStore.getState().upsertRequired({
      kind: "team_preview",
      conversationId: CID,
      messageId: "m-server-tp",
      origin: "server",
      payload: {
        checkpoint_id: "tp-live",
        conversation_id: CID,
        primitive: "delegate",
        workers: [
          { run_id: "r1", role: "研究员", task: "调研", depends_on: [] },
        ],
        tools: ["file_write"],
        motion: "",
        form: "",
        sides: [],
        max_rounds: 0,
        thorough: true,
      },
    });

    render(<ResumePrompt />);

    expect(
      screen.getByText("团队尚未开工。等待你确认后才会上场，请过目分工："),
    ).toBeTruthy();
    expect(screen.getByText("授权并开工")).toBeTruthy();
    // Must not have required message_end → surfaceResume dual-write.
    expect(usePausedTurnStore.getState().pending).toHaveLength(0);
  });

  it("does not paint clickable card before serverMessageId stamp", () => {
    useConversationStore.setState({ currentConversationId: null, byId: {} });
    useConversationStore.getState().switchConversation(CID);
    useConversationStore.getState().addMessage({
      id: "u1",
      role: "user",
      content: "组团",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    });
    useConversationStore.getState().addMessage({
      id: "client-only",
      role: "assistant",
      content: "",
      createdAt: "",
      executionId: null,
      isStreaming: true,
    });

    useInteractionStore.getState().upsertRequired({
      kind: "team_preview",
      conversationId: CID,
      messageId: "client-only",
      origin: "sidecar",
      payload: {
        checkpoint_id: "tp-nostamp",
        conversation_id: CID,
        primitive: "delegate",
        workers: [{ run_id: "r1", role: "研", task: "t", depends_on: [] }],
        tools: [],
        motion: "",
        form: "",
        sides: [],
        max_rounds: 0,
        thorough: true,
      },
    });

    const { container } = render(<ResumePrompt />);
    expect(container.querySelector(".mx-4")).toBeNull();
    expect(screen.queryByText("授权并开工")).toBeNull();
  });

  it("keeps origin=sidecar on Interaction entry for submit routing", () => {
    useInteractionStore.getState().upsertRequired({
      kind: "team_preview",
      conversationId: CID,
      messageId: "m-server-tp",
      origin: "sidecar",
      payload: {
        checkpoint_id: "tp-side",
        conversation_id: CID,
        primitive: "delegate",
        workers: [{ run_id: "r1", role: "研", task: "t", depends_on: [] }],
        tools: [],
        motion: "",
        form: "",
        sides: [],
        max_rounds: 0,
        thorough: true,
      },
    });

    render(<ResumePrompt />);
    expect(useInteractionStore.getState().byId.get("tp-side")?.origin).toBe(
      "sidecar",
    );
  });
});
