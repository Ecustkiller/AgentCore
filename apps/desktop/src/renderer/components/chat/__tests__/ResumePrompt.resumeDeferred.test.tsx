import { TooltipProvider } from "@/components/ui/tooltip";
import { resumeDeferredCardCopy } from "@/lib/resumeDeferred";
import { useConversationStore } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import { usePausedTurnStore } from "@/stores/pausedTurns";
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResumePrompt } from "../ResumePrompt";

vi.mock("@/services/interactionSubmit", () => ({
  submitInteraction: vi.fn().mockResolvedValue("ok"),
  notifySubmitInteractionResult: vi.fn(),
  submitInteractionFeedback: (result: "busy" | "orphaned") =>
    result === "orphaned" ? "确认已失效" : "请稍候再试",
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

const CID = "conv-deferred-ui";
const MID = "m-server-deferred";
const IX_ID = "pr-deferred-ui";

function renderResume() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ResumePrompt />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePausedTurnStore.getState().clear();
  useInteractionStore.getState().clear();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().addMessage({
    id: "u1",
    role: "user",
    content: "推进计划",
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
  useConversationStore.getState().setServerMessageIdOnLastMessage(MID, CID);
  useInteractionStore.getState().upsertRequired({
    kind: "plan_review",
    conversationId: CID,
    messageId: MID,
    origin: "server",
    payload: {
      checkpoint_id: IX_ID,
      conversation_id: CID,
      steps: [{ run_id: "r1", role: "调研", summary: "方案就绪" }],
      pending: [{ run_id: "r2", role: "执行" }],
    },
  });
  useInteractionStore.getState().beginSubmit(IX_ID);
  useInteractionStore.getState().markResumeDeferred({
    conversationId: CID,
    messageId: MID,
    busyReason: "live_turn",
  });
});

afterEach(() => {
  cleanup();
  usePausedTurnStore.getState().clear();
  useInteractionStore.getState().clear();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

describe("ResumePrompt · resume_deferred 呈现", () => {
  it("shows deferred notice and hides cancel", () => {
    renderResume();
    expect(screen.getByTestId("resume-deferred-notice").textContent).toBe(
      resumeDeferredCardCopy("live_turn"),
    );
    expect(screen.getByText("已记下")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.queryByText("回合收尾尚未完成")).toBeNull();
  });
});
