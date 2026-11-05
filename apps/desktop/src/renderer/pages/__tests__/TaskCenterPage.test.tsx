// @vitest-environment jsdom
import { TaskCenterPage } from "@/pages/TaskCenterPage";
import type { HandoffJob } from "@/services/handoff";
import { useConversationStore } from "@/stores/conversation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const taskState = vi.hoisted(() => ({
  jobs: [] as HandoffJob[],
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));

const layoutState = vi.hoisted(() => ({
  isNarrow: false,
  setConversationDrawerOpen: vi.fn(),
}));

vi.mock("@/lib/narrowLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/narrowLayout")>();
  return {
    ...actual,
    useNarrowLayoutState: () => ({
      isNarrow: layoutState.isNarrow,
      hideChrome: false,
      conversationDrawerOpen: false,
      setConversationDrawerOpen: layoutState.setConversationDrawerOpen,
    }),
  };
});

vi.mock("@/hooks/useHandoffTasks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useHandoffTasks")>();
  return {
    ...actual,
    useHandoffTasks: () => ({
      data: taskState.jobs,
      isLoading: taskState.isLoading,
      isError: taskState.isError,
      isFetching: taskState.isFetching,
      refetch: taskState.refetch,
    }),
  };
});

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => [
    {
      id: "source-1",
      title: "季度复盘",
      updatedAt: "2026-11-06T01:00:00Z",
      messageCount: 4,
      lastMessagePreview: null,
    },
  ],
  useGroupedConversationsSettled: () => true,
}));

function job(overrides: Partial<HandoffJob>): HandoffJob {
  return {
    id: "job-1",
    sourceConversationId: "source-1",
    jobConversationId: "job-conversation-1",
    baseSnapshotId: "base",
    resultSnapshotId: null,
    task: "整理季度复盘",
    status: "running",
    error: null,
    createdAt: "2026-11-06T01:00:00Z",
    updatedAt: "2026-11-06T01:10:00Z",
    finishedAt: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <Routes>
        <Route path="/tasks" element={<TaskCenterPage />} />
        <Route
          path="/conversations/:id"
          element={<div data-testid="conversation-route" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  taskState.jobs = [
    job({ id: "running", status: "running", task: "扫描竞品资料" }),
    job({
      id: "awaiting",
      status: "succeeded",
      task: "生成研究报告",
      resultSnapshotId: "result",
      finishedAt: "2026-11-06T02:00:00Z",
    }),
    job({
      id: "done",
      status: "applied",
      task: "同步发布说明",
      resultSnapshotId: "result-2",
      finishedAt: "2026-11-06T03:00:00Z",
    }),
  ];
  taskState.isLoading = false;
  taskState.isError = false;
  taskState.isFetching = false;
  layoutState.isNarrow = false;
});

afterEach(() => {
  cleanup();
  taskState.refetch.mockReset();
  vi.restoreAllMocks();
});

describe("TaskCenterPage", () => {
  it("aggregates running, awaiting, and finished jobs with source titles", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "任务" })).toBeTruthy();
    expect(screen.getByText("1 个进行中")).toBeTruthy();
    expect(screen.getByText("扫描竞品资料")).toBeTruthy();
    expect(screen.getByText("生成研究报告")).toBeTruthy();
    expect(screen.getByText("同步发布说明")).toBeTruthy();
    expect(screen.getAllByText("来源：季度复盘")).toHaveLength(3);
  });

  it("filters by status and searches task text", () => {
    renderPage();

    fireEvent.click(screen.getByRole("tab", { name: "待处理 1" }));
    expect(screen.getByText("生成研究报告")).toBeTruthy();
    expect(screen.queryByText("扫描竞品资料")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "全部 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索任务" }), {
      target: { value: "发布说明" },
    });
    expect(screen.getByText("同步发布说明")).toBeTruthy();
    expect(screen.queryByText("生成研究报告")).toBeNull();
  });

  it("opens the source conversation for a result that needs review", () => {
    const switchConversation = vi
      .spyOn(useConversationStore.getState(), "switchConversation")
      .mockImplementation(() => undefined);
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "处理结果" }));

    expect(switchConversation).toHaveBeenCalledWith("source-1");
    expect(screen.getByTestId("conversation-route")).toBeTruthy();
  });

  it("surfaces load failure with a retry action", () => {
    taskState.isError = true;
    renderPage();

    expect(screen.getByText("任务加载失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(taskState.refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the page title and refresh action in the narrow header", () => {
    layoutState.isNarrow = true;
    renderPage();

    expect(screen.getByRole("heading", { name: "任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开侧栏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新任务" })).toBeTruthy();
  });
});
