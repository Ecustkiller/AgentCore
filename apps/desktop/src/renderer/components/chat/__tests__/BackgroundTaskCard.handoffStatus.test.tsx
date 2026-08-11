// @vitest-environment jsdom
import { BackgroundTaskCard } from "@/components/chat/BackgroundTaskCard";
import type { HandoffJob } from "@/services/handoff";
import { discardHandoffJob } from "@/services/handoff";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/handoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/handoff")>();
  return {
    ...actual,
    discardHandoffJob: vi.fn(),
  };
});

vi.mock("@/components/chat/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("@/components/chat/BackgroundTaskReview", () => ({
  BackgroundTaskReview: () => <div>review</div>,
}));

const discardJob = vi.mocked(discardHandoffJob);

const job = (over: Partial<HandoffJob> = {}): HandoffJob => ({
  id: "job-1",
  sourceConversationId: "c1",
  jobConversationId: "job-conv-1",
  baseSnapshotId: "snap-base",
  resultSnapshotId: "snap-result",
  task: "调研竞品",
  status: "succeeded",
  error: null,
  createdAt: "2026-07-10T00:00:00Z",
  updatedAt: "2026-07-10T00:00:00Z",
  finishedAt: "2026-07-10T00:00:00Z",
  ...over,
});

beforeEach(() => {
  discardJob.mockReset();
  useBackgroundTasksStore.setState({
    byConversation: {},
    modeByConversation: {},
    rootIdByConversation: {},
    mergedJobIds: {},
  });
});

describe("BackgroundTaskCard §7.6 status badges", () => {
  it("succeeded shows 待合回本机 + 放弃结果", () => {
    render(<BackgroundTaskCard job={job()} rootId="root-1" />);
    expect(screen.getByText("待合回本机")).toBeTruthy();
    expect(screen.getByText("放弃结果")).toBeTruthy();
    expect(screen.getByText("查看改动并合回本机")).toBeTruthy();
  });

  it("applied / discarded never show 待合回本机", () => {
    const { rerender } = render(
      <BackgroundTaskCard job={job({ status: "applied" })} rootId="root-1" />,
    );
    expect(screen.getByText("已合回本机")).toBeTruthy();
    expect(screen.queryByText("待合回本机")).toBeNull();
    expect(screen.queryByText("放弃结果")).toBeNull();

    rerender(
      <BackgroundTaskCard job={job({ status: "discarded" })} rootId="root-1" />,
    );
    expect(screen.getByText("已丢弃")).toBeTruthy();
    expect(screen.queryByText("待合回本机")).toBeNull();
    expect(screen.queryByText("放弃结果")).toBeNull();
  });

  it("放弃结果 calls discard and upserts discarded", async () => {
    discardJob.mockResolvedValueOnce(job({ status: "discarded" }));
    useBackgroundTasksStore.setState({
      byConversation: { c1: [job()] },
    });

    render(<BackgroundTaskCard job={job()} rootId="root-1" />);
    fireEvent.click(screen.getByText("放弃结果"));

    await waitFor(() => {
      expect(discardJob).toHaveBeenCalledWith("c1", "job-1");
      expect(
        useBackgroundTasksStore.getState().byConversation.c1[0].status,
      ).toBe("discarded");
    });
  });
});
