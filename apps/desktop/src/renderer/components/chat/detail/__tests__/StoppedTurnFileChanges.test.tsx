// @vitest-environment jsdom
/**
 * 回合详情收口：硬停且有工作区改动 → 露出入口；无改动不渲染。
 */
import { StoppedTurnFileChangesSection } from "@/components/chat/detail/sections/StoppedTurnFileChanges";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type ExecutionPlan,
  type RunFrame,
  projectExecution,
} from "@/stores/execution";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MID = "msg-stopped-detail";

const { getTurnFilesDiff, getLocalTurnFilesDiff } = vi.hoisted(() => ({
  getTurnFilesDiff: vi.fn(),
  getLocalTurnFilesDiff: vi.fn(),
}));

vi.mock("@/services/turnFilesDiff", () => ({
  getTurnFilesDiff,
  getLocalTurnFilesDiff,
  restoreLocalTurnBaseline: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useConversationWorkspace: () => null,
}));

const plan: ExecutionPlan = {
  id: "exec-stopped-detail",
  planType: "multi_agent",
  taskSummary: "写文档",
  agents: [{ id: "w1", role: "文档撰写员" }],
  runs: [{ id: "r1", agentId: "w1", task: "落盘", dependsOn: [] }],
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
    kind: "run_cancelled",
    runId: "r1",
    agentId: "w1",
    reason: "stop",
  },
];

function emptyDiff(total = 0) {
  return {
    messageId: MID,
    baselineSnapshotId: total > 0 ? "snap-1" : null,
    available: true,
    changes:
      total > 0
        ? [
            {
              path: "docs/draft.md",
              changeType: "added" as const,
              baseSha: null,
              resultSha: "r1",
              isBinary: false,
              content: "半截",
              sizeBytes: 6,
              baseContent: null,
            },
          ]
        : [],
    total,
    added: total,
    modified: 0,
    deleted: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getTurnFilesDiff.mockResolvedValue(emptyDiff(0));
  getLocalTurnFilesDiff.mockResolvedValue(emptyDiff(0));
});

afterEach(() => {
  cleanup();
});

describe("StoppedTurnFileChangesSection", () => {
  it("cancelled + file changes → 露出入口与文件数", async () => {
    getTurnFilesDiff.mockResolvedValue(emptyDiff(1));
    const exec = projectExecution(plan, frames, "cancelled");

    render(
      <TooltipProvider>
        <StoppedTurnFileChangesSection
          execution={exec}
          conversationId="conv-1"
          messageId={MID}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("run-detail-stopped-file-changes"),
      ).toBeTruthy();
    });
    expect(screen.getByText("本回合已停止，改动了 1 个文件")).toBeTruthy();
    expect(screen.getByText("工作区改动")).toBeTruthy();
  });

  it("cancelled but no file changes → 不显示", async () => {
    getTurnFilesDiff.mockResolvedValue(emptyDiff(0));
    const exec = projectExecution(plan, frames, "cancelled");

    const { container } = render(
      <TooltipProvider>
        <StoppedTurnFileChangesSection
          execution={exec}
          conversationId="conv-1"
          messageId={MID}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(getTurnFilesDiff).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("run-detail-stopped-file-changes")).toBeNull();
    expect(screen.queryByText("工作区改动")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
