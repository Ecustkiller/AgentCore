// @vitest-environment jsdom
import type { StandingTaskRun } from "@/services/standingTasks";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/standingTasks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/standingTasks")>();
  return {
    ...actual,
    listStandingTaskRuns: vi.fn(),
    countInboxBadge: vi.fn(async () => 0),
  };
});

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

import { listStandingTaskRuns } from "@/services/standingTasks";
import { MemoryRouter } from "react-router-dom";
import { InboxPanel } from "../InboxPanel";

const runs = vi.mocked(listStandingTaskRuns);

function run(over: Partial<StandingTaskRun> & { id: string }): StandingTaskRun {
  return {
    standingTaskId: "task-1",
    taskName: "竞品简报",
    status: "succeeded",
    conversationId: null,
    userMessageId: null,
    summary: null,
    error: null,
    ackedAt: null,
    triggerSource: null,
    createdAt: "2026-08-01T00:00:00Z",
    finishedAt: "2026-08-01T01:00:00Z",
    ...over,
  };
}

function renderPanel() {
  render(
    <MemoryRouter>
      <InboxPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  runs.mockReset();
  runs.mockResolvedValue([
    run({ id: "run-done", summary: "已跑完的一轮" }),
    run({ id: "run-hold", status: "awaiting_user", summary: "等你拍板" }),
  ]);
});

afterEach(cleanup);

describe("InboxPanel 筛选条", () => {
  it("是按钮筛选而非导航——不产生链接、不改路由", async () => {
    renderPanel();

    const group = await screen.findByRole("group", { name: "收件箱筛选" });
    expect(group.querySelectorAll("a").length).toBe(0);
    for (const label of ["全部", "待处理"]) {
      expect(
        screen
          .getByRole("button", { name: label })
          .getAttribute("aria-pressed"),
      ).toBe(label === "全部" ? "true" : "false");
    }
  });

  it("切到「待处理」只留待拍板与未读失败", async () => {
    renderPanel();

    expect(await screen.findByText("已跑完的一轮")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "待处理" }));

    await waitFor(() => expect(screen.queryByText("已跑完的一轮")).toBeNull());
    expect(screen.getByText("等你拍板")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "待处理" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
