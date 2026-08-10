import { TooltipProvider } from "@/components/ui/tooltip";
import { useConversationStore } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import { usePausedTurnStore } from "@/stores/pausedTurns";
// @vitest-environment jsdom
/**
 * Live cold card authority = InteractionStore: team_preview_required with a
 * server stamp paints ResumePrompt without message_end → surfaceResume.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

vi.mock("@/hooks/useModels", () => ({
  useModels: () => ({
    data: {
      models: [
        {
          id: "ceo-flash",
          display_name: "CEO Flash",
          origin: "platform",
          available: true,
        },
        {
          id: "worker-pro",
          display_name: "Worker Pro",
          origin: "platform",
          available: true,
        },
      ],
      current: { id: "ceo-flash", origin: "platform" },
    },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/useLlmProviders", () => ({
  useLlmProviders: () => ({
    data: { providers: [], platform_available: true },
    isLoading: false,
    isError: false,
  }),
}));

const CID = "conv-live-ix";

const tpPayload = (
  checkpointId: string,
  over: Record<string, unknown> = {},
) => ({
  checkpoint_id: checkpointId,
  conversation_id: CID,
  primitive: "delegate" as const,
  workers: [
    { run_id: "r1", role: "研究员", task: "调研", depends_on: [] as string[] },
  ],
  tools: ["file_write"],
  motion: "",
  form: "",
  sides: [] as string[],
  max_rounds: 0,
  thorough: true,
  ...over,
});

function renderResume() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ResumePrompt />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

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
      payload: tpPayload("tp-live"),
    });

    renderResume();

    expect(screen.getByText("预计 1 人开工")).toBeTruthy();
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
      payload: tpPayload("tp-nostamp"),
    });

    const { container } = renderResume();
    expect(container.querySelector(".mx-4")).toBeNull();
    expect(screen.queryByText("授权并开工")).toBeNull();
  });

  it("paints after stamp arrives (client-bound pending → rekey)", () => {
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
      id: "client-late",
      role: "assistant",
      content: "",
      createdAt: "",
      executionId: null,
      isStreaming: true,
    });

    useInteractionStore.getState().upsertRequired({
      kind: "team_preview",
      conversationId: CID,
      messageId: "client-late",
      origin: "server",
      payload: tpPayload("tp-late-stamp"),
    });

    renderResume();
    expect(screen.queryByText("授权并开工")).toBeNull();

    act(() => {
      useConversationStore
        .getState()
        .setServerMessageIdOnLastMessage("m-server-late", CID);
    });

    expect(screen.getByText("授权并开工")).toBeTruthy();
    expect(
      useInteractionStore.getState().byId.get("tp-late-stamp")?.messageId,
    ).toBe("m-server-late");
  });

  it("paints after stamp when pending arrived unbound (empty messageId)", () => {
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
      id: "client-unbound",
      role: "assistant",
      content: "",
      createdAt: "",
      executionId: null,
      isStreaming: true,
    });

    useInteractionStore.getState().upsertRequired({
      kind: "ask_user",
      conversationId: CID,
      messageId: "",
      origin: "server",
      payload: {
        checkpoint_id: "cp-unbound",
        conversation_id: CID,
        question: "第二轮拍板？",
        context: "",
        assumptions: [],
        questions: [],
      },
    });

    renderResume();
    expect(screen.queryByText("第二轮拍板？")).toBeNull();

    act(() => {
      useConversationStore
        .getState()
        .setServerMessageIdOnLastMessage("m-server-unbound", CID);
    });

    expect(screen.getByText("第二轮拍板？")).toBeTruthy();
    expect(
      useInteractionStore.getState().byId.get("cp-unbound")?.messageId,
    ).toBe("m-server-unbound");
  });

  it("second-round team_preview paints after first round resolved", () => {
    useInteractionStore.getState().upsertRequired({
      kind: "team_preview",
      conversationId: CID,
      messageId: "m-server-tp",
      origin: "server",
      payload: tpPayload("tp-round1"),
    });
    useInteractionStore.getState().markResolved({
      kind: "team_preview",
      id: "tp-round1",
      resolution: { decision: "continue" },
    });

    useConversationStore.getState().addMessage({
      id: "u2",
      role: "user",
      content: "再组一轮",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    });
    useConversationStore.getState().addMessage({
      id: "client-r2",
      role: "assistant",
      content: "",
      createdAt: "",
      executionId: null,
      isStreaming: true,
    });
    useConversationStore
      .getState()
      .setServerMessageIdOnLastMessage("m-server-tp-r2", CID);

    useInteractionStore.getState().upsertRequired({
      kind: "team_preview",
      conversationId: CID,
      messageId: "m-server-tp-r2",
      origin: "server",
      payload: tpPayload("tp-round2", {
        workers: [{ run_id: "r2", role: "写", task: "写", depends_on: [] }],
      }),
    });

    renderResume();
    expect(screen.getByText("授权并开工")).toBeTruthy();
    expect(
      useInteractionStore.getState().listPending(CID, ["team_preview"]),
    ).toHaveLength(1);
  });

  it("second-round ask_user paints after first ask resolved", () => {
    useInteractionStore.getState().upsertRequired({
      kind: "ask_user",
      conversationId: CID,
      messageId: "m-server-tp",
      origin: "server",
      payload: {
        checkpoint_id: "cp-r1",
        conversation_id: CID,
        question: "第一轮？",
        context: "",
        assumptions: [],
        questions: [],
      },
    });
    useInteractionStore.getState().markResolved({
      kind: "ask_user",
      id: "cp-r1",
      resolution: { decision: "continue" },
    });

    useConversationStore.getState().addMessage({
      id: "u2",
      role: "user",
      content: "继续问",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    });
    useConversationStore.getState().addMessage({
      id: "client-ask-r2",
      role: "assistant",
      content: "",
      createdAt: "",
      executionId: null,
      isStreaming: true,
    });
    useConversationStore
      .getState()
      .setServerMessageIdOnLastMessage("m-server-ask-r2", CID);

    useInteractionStore.getState().upsertRequired({
      kind: "ask_user",
      conversationId: CID,
      messageId: "m-server-ask-r2",
      origin: "server",
      payload: {
        checkpoint_id: "cp-r2",
        conversation_id: CID,
        question: "第二轮拍板？",
        context: "",
        assumptions: [],
        questions: [],
      },
    });

    renderResume();
    expect(screen.getByText("第二轮拍板？")).toBeTruthy();
    expect(screen.queryByText("第一轮？")).toBeNull();
  });

  it("keeps origin=sidecar on Interaction entry for submit routing", () => {
    useInteractionStore.getState().upsertRequired({
      kind: "team_preview",
      conversationId: CID,
      messageId: "m-server-tp",
      origin: "sidecar",
      payload: tpPayload("tp-side"),
    });

    renderResume();
    expect(useInteractionStore.getState().byId.get("tp-side")?.origin).toBe(
      "sidecar",
    );
  });
});
