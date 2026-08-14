// @vitest-environment jsdom
/**
 * User stop seals cancelled — StatusStrip paints stopped chrome (战绩 n/m),
 * never frameless「继续」/ live spinner / graph-mounted 重试.
 * 硬停改动入口不在状态条（产物卡 / 右坞「改动」tab / 画布详情段）。
 * 整轮 Stop 在输入框，不在状态条。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import { conversationKeys } from "@/lib/queryKeys";
import {
  type ExecutionPlan,
  type RunFrame,
  projectExecution,
} from "@/stores/execution";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusStrip } from "../StatusStrip";

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
        <StatusStrip
          execution={execution}
          expanded
          onToggle={() => {}}
          onMaximize={() => {}}
          onReplay={() => {}}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("StatusStrip · user stop cancelled", () => {
  it("status=cancelled → 已停止, no 重试 / 继续 / spinner / stop", () => {
    const exec = projectExecution(plan, frames, "cancelled");
    expect(exec.status).toBe("cancelled");

    const { container } = renderStrip(exec);

    expect(screen.getByText("已停止")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重试失败项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByLabelText("停止整轮")).toBeNull();
    expect(screen.queryByText(/改动 \d+ 个文件/)).toBeNull();
  });
});
