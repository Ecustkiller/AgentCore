// @vitest-environment jsdom
/**
 * User stop seals cancelled — StatusStrip paints stopped chrome (战绩陈述),
 * never frameless「继续」/ live spinner / graph-mounted 重试.
 * 硬停且本回合动过工作区 → 露出改动入口；无改动不显示。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import { conversationKeys } from "@/lib/queryKeys";
import {
  type ExecutionPlan,
  ExecutionScopeContext,
  type RunFrame,
  projectExecution,
} from "@/stores/execution";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusStrip } from "../StatusStrip";

const MID = "msg-stopped-strip";

const { getTurnFilesDiff, getLocalTurnFilesDiff, showChanges } = vi.hoisted(
  () => ({
    getTurnFilesDiff: vi.fn(),
    getLocalTurnFilesDiff: vi.fn(),
    showChanges: vi.fn(),
  }),
);

vi.mock("@/services/turnFilesDiff", () => ({
  getTurnFilesDiff,
  getLocalTurnFilesDiff,
  restoreLocalTurnBaseline: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useConversationWorkspace: () => null,
}));

vi.mock("@/stores/sidePanel", async () => {
  const actual =
    await vi.importActual<typeof import("@/stores/sidePanel")>(
      "@/stores/sidePanel",
    );
  return {
    ...actual,
    useSidePanelStore: (
      sel: (s: { showChanges: typeof showChanges }) => unknown,
    ) => sel({ showChanges }),
  };
});

vi.mock("@/stores/conversation", async () => {
  const actual = await vi.importActual<typeof import("@/stores/conversation")>(
    "@/stores/conversation",
  );
  return {
    ...actual,
    useActiveGenerating: () => false,
    useActiveTurnPhase: () => "idle",
    useConversationStore: (
      sel: (s: {
        currentConversationId: string;
        stopGeneration: () => void;
      }) => unknown,
    ) =>
      sel({
        currentConversationId: "conv-1",
        stopGeneration: () => {},
      }),
    getActiveRuntime: () => ({ messages: [] }),
  };
});

vi.mock("@/services/turns", () => ({
  lastUserMessageId: () => null,
  runRegenerate: vi.fn(),
}));

const plan: ExecutionPlan = {
  id: "exec-stopped",
  planType: "multi_agent",
  taskSummary: "并行调研",
  agents: [{ id: "w1", role: "研究员" }],
  runs: [{ id: "r1", agentId: "w1", task: "调研", dependsOn: [] }],
};

const frames: RunFrame[] = [
  {
    t: 1,
    kind: "run_started",
    runId: "r1",
    agentId: "w1",
    parentRunId: null,
    runKind: "agent",
    continuesRunId: null,
  },
  {
    t: 2,
    kind: "run_completed",
    runId: "r1",
    agentId: "w1",
    outputSummary: "完成调研",
    durationMs: 1000,
  },
];

function emptyDiff(total = 0) {
  return {
    messageId: MID,
    baselineSnapshotId: total > 0 ? "snap-1" : null,
    available: true,
    changes: [],
    total,
    added: total,
    modified: 0,
    deleted: 0,
  };
}

function renderStrip(execution: ReturnType<typeof projectExecution>) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(conversationKeys.grouped, {
    folders: [],
    conversations: [],
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ExecutionScopeContext.Provider value={MID}>
          <StatusStrip
            execution={execution}
            expanded
            onToggle={() => {}}
            onMaximize={() => {}}
            onReplay={() => {}}
          />
        </ExecutionScopeContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getTurnFilesDiff.mockResolvedValue(emptyDiff(0));
  getLocalTurnFilesDiff.mockResolvedValue(emptyDiff(0));
});

afterEach(() => {
  cleanup();
});

describe("StatusStrip · user stop cancelled", () => {
  it("status=cancelled → 已停止, no 重试 / 继续 / spinner / stop", async () => {
    const exec = projectExecution(plan, frames, "cancelled");
    expect(exec.status).toBe("cancelled");

    const { container } = renderStrip(exec);

    expect(screen.getByText("已停止")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重试失败项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByLabelText("停止任务")).toBeNull();
    await waitFor(() => {
      expect(
        screen.queryByTestId("status-strip-stopped-file-changes"),
      ).toBeNull();
    });
  });

  it("cancelled + baseline file changes → 露出改动入口", async () => {
    getTurnFilesDiff.mockResolvedValue(emptyDiff(2));
    const exec = projectExecution(plan, frames, "cancelled");
    renderStrip(exec);

    await waitFor(() => {
      expect(
        screen.getByTestId("status-strip-stopped-file-changes"),
      ).toBeTruthy();
    });
    expect(screen.getByText("改动 2 个文件")).toBeTruthy();
    expect(getTurnFilesDiff).toHaveBeenCalledWith("conv-1", MID);
  });

  it("cancelled + tool file artifacts (no baseline) → 露出改动入口", async () => {
    getTurnFilesDiff.mockResolvedValue({
      ...emptyDiff(0),
      available: false,
      baselineSnapshotId: null,
    });
    const exec = projectExecution(plan, frames, "cancelled");
    const agent = exec.agents.find((a) => a.id === "w1");
    expect(agent).toBeTruthy();
    if (!agent) throw new Error("expected agent w1");
    agent.toolCalls.push({
      id: "tc-write",
      toolName: "file_write",
      arguments: { path: "docs/draft.md", content: "半截正文" },
      result: "ok",
      status: "success",
    });

    renderStrip(exec);

    await waitFor(() => {
      expect(
        screen.getByTestId("status-strip-stopped-file-changes"),
      ).toBeTruthy();
    });
    expect(screen.getByText("改动 1 个文件")).toBeTruthy();
  });

  it("cancelled but no file changes → 不显示改动入口", async () => {
    getTurnFilesDiff.mockResolvedValue(emptyDiff(0));
    const exec = projectExecution(plan, frames, "cancelled");
    renderStrip(exec);

    await waitFor(() => {
      expect(getTurnFilesDiff).toHaveBeenCalled();
    });
    expect(
      screen.queryByTestId("status-strip-stopped-file-changes"),
    ).toBeNull();
    expect(screen.queryByText(/改动 \d+ 个文件/)).toBeNull();
  });
});
