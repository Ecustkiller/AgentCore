// @vitest-environment jsdom
/**
 * 点下去才发现这张卡早被处理过（冷 resume 幂等成功）→ 原位留一条**中性**收口，说清何时以
 * 什么决策结的。这对用户不是故障（多端同权下别人先处理了很正常），所以不许出现红色告警的
 * 视觉语言；`running` 更不出条——那会儿 AI 正在续写，屏幕上已经有最好的交代了。
 */
import { ResumeSettledNotices } from "@/components/chat/ResumeSettledNotices";
import { useConversationStore } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CID = "conv-resume-settled";
const MID = "srv-msg-1";

function settle(
  id: string,
  turnStatus: "running" | "complete" | "failed",
  conversationId = CID,
): void {
  act(() => {
    useInteractionStore.getState().markResumeSettled({
      id,
      kind: "plan_review",
      conversationId,
      messageId: MID,
      decision: "continue",
      decidedAt: "2026-08-13T09:30:00.000Z",
      turnStatus,
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useInteractionStore.setState({ byId: new Map() });
  useConversationStore.setState({ currentConversationId: CID });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useInteractionStore.setState({ byId: new Map() });
  useConversationStore.setState({ currentConversationId: null });
});

describe("ResumeSettledNotices", () => {
  it("已结的卡 → 原位说清何时以什么决策处理，一段时间后自行退场", () => {
    render(<ResumeSettledNotices />);
    expect(screen.queryByTestId("resume-settled")).toBeNull();

    settle("cp-1", "complete");

    expect(screen.getByText(/计划复核/)).toBeTruthy();
    expect(screen.getByText(/以「继续」处理/)).toBeTruthy();
    expect(screen.getByText(/这次回合已经跑完/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(screen.queryByTestId("resume-settled")).toBeNull();
  });

  it("running 不出条：AI 正在继续，屏幕上已经看得见", () => {
    render(<ResumeSettledNotices />);
    settle("cp-2", "running");

    expect(screen.queryByTestId("resume-settled")).toBeNull();
  });

  it("失败也是结局，不用红色告警说事", () => {
    render(<ResumeSettledNotices />);
    settle("cp-3", "failed");

    const notice = screen.getByTestId("resume-settled");
    expect(notice.textContent).toContain("以失败收场");
    expect(notice.innerHTML).not.toContain("destructive");
  });

  it("别的会话的卡不串门", () => {
    render(<ResumeSettledNotices />);
    settle("cp-4", "complete", "other-conv");

    expect(screen.queryByTestId("resume-settled")).toBeNull();
  });
});
