// @vitest-environment jsdom
/**
 * 画布指挥台里挂起标记的指路必须跟真实装配顺序一致。
 *
 * 这里的顺序与聊天面相反——`ConversationDecisionPrompts`（拍板卡）在最上，plan_review /
 * checkpoint 卡片列在其下。所以断言不只看文案，还比对 DOM 先后：拍板卡确实在标记之前，
 * 标记也确实说「上方」。哪天装配顺序被改回去，这条会红。
 */
import { CommandPanelBody } from "@/components/graph/CanvasDecisionPanel";
import type { PlanReviewDisplay } from "@/stores/conversation";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const planReview: PlanReviewDisplay = {
  id: "pr-canvas",
  steps: [{ run_id: "r1", role: "调研", summary: "方案就绪" }],
  pending: [{ run_id: "r2", role: "执行" }],
  status: "pending",
  decision: null,
  note: "",
};

vi.mock("@/components/chat/RetryBanner", () => ({
  RetryBanner: () => null,
}));

vi.mock("@/components/chat/ConversationDecisionPrompts", () => ({
  // 拍板中心（ResumePrompt 等）的位置替身——本用例只关心它排在哪。
  ConversationDecisionPrompts: () => <div data-testid="decision-prompts" />,
}));

vi.mock("@/components/chat/StageCardDock", () => ({
  StageCardDock: () => null,
}));

vi.mock("@/components/chat/CheckpointCard", () => ({
  CheckpointCard: () => null,
}));

vi.mock("@/components/chat/EscalationCard", () => ({
  EscalationCards: () => null,
}));

vi.mock("@/components/chat/BackgroundTaskCard", () => ({
  BackgroundTaskCard: () => null,
}));

vi.mock("@/stores/backgroundTasks", () => ({
  useBackgroundTasks: () => [],
  useWorkspaceRootId: () => null,
}));

vi.mock("@/stores/interactions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/interactions")>();
  return {
    ...actual,
    useMessageInteractionCards: () => ({
      checkpoints: [],
      nonBlockingAsks: [],
      planReviews: [planReview],
      teamPreviews: [],
    }),
  };
});

afterEach(cleanup);

describe("画布指挥台 · 挂起标记指路", () => {
  it("拍板卡在上，标记就说上方", () => {
    render(
      <CommandPanelBody
        message={undefined}
        conversationId="c1"
        interactive={false}
      />,
    );

    const prompts = screen.getByTestId("decision-prompts");
    const marker = screen.getByTestId("pending-decision-marker");

    expect(marker.textContent).toContain("入口在上方拍板卡");
    // DOCUMENT_POSITION_FOLLOWING = 4：marker 排在拍板卡之后。
    expect(
      prompts.compareDocumentPosition(marker) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
