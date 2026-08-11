// @vitest-environment jsdom
/**
 * RunDetailBody 单人停止入口：可停态才出现；点击走 requestRunStop；请求中禁用。
 */
import { RunDetailBody } from "@/components/chat/detail/RunDetailBody";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentState, Execution, RunNode } from "@/stores/execution";
import { useRunStopPendingStore } from "@/stores/runStopPending";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitRunStop = vi.fn();

vi.mock("@/services/runStop", () => ({
  submitRunStop: (...args: unknown[]) => submitRunStop(...args),
}));

vi.mock("@/stores/execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/execution")>();
  return {
    ...actual,
    useMessageExecution: () => mockExecution,
  };
});

vi.mock("@/stores/conversation", () => ({
  useConversationStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      currentConversationId: "c1",
      messages: [{ id: "m1", isStreaming: true, collab: null, traceId: null }],
      stopGeneration: vi.fn(),
    }),
  activeRuntime: (s: { messages: unknown[] }) => s,
  runtimeOf: () => ({ toolStartedMs: {} }),
}));

vi.mock("@/stores/sidePanel", () => ({
  useSidePanelStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ showRunDetail: vi.fn() }),
}));

vi.mock("@/stores/ui", () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ diagnosticMode: false }),
  turnDetailPath: () => "/t",
}));

vi.mock("@/hooks/useTurnAudit", () => ({
  useTurnAudit: () => ({ data: null }),
}));

vi.mock("@/hooks/useRunLlmWindow", () => ({
  useRunLlmWindow: () => ({ data: null, loading: false, error: null }),
}));

vi.mock("@/stores/disclosure", () => ({
  useStreamAwareDisclosure: () => [true, vi.fn()],
  usePersistentDisclosure: () => [false, vi.fn()],
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(cleanup);

const baseAgent: AgentState = {
  id: "w1",
  role: "调研员",
  thinking: false,
  status: "idle",
  currentRunId: null,
  outputChunks: [],
  reasoningChunks: [],
  toolCalls: [],
  toolProgress: null,
  toolExecutionLive: null,
};

const baseRun: RunNode = {
  id: "r1",
  agentId: "w1",
  task: "调研竞品",
  status: "pending",
  dependsOn: [],
  outputSummary: null,
  outputFiles: [],
  debrief: null,
  durationMs: null,
  startedAt: null,
  error: null,
  parentRunId: null,
  kind: "agent",
  role: "member",
  model: null,
  usage: null,
  cost: null,
  stance: null,
  group: null,
  round: 0,
  sideKey: null,
  continuesRunId: null,
  continuationIndex: 0,
  revised: null,
  replacesRunId: null,
  checkpoint: null,
  receivedContext: [],
  escalations: [],
  process: [],
};

let mockExecution: Execution = {
  id: "exec1",
  planType: "multi_agent",
  taskSummary: "调研竞品",
  status: "running",
  agents: [baseAgent],
  runs: [baseRun],
  acts: [
    {
      actId: "act-1",
      kind: "multi_agent",
      title: null,
      anchorRunId: null,
      authorizedBy: null,
    },
  ],
  progress: { completed: 0, total: 1 },
  batches: [],
  debate: null,
  debateRounds: [],
  crossExamEnabled: false,
  debateOpening: null,
  debatePretrial: null,
  teamNotes: [],
};

function seed(opts: {
  agentStatus: AgentState["status"];
  runStatus: RunNode["status"];
}) {
  mockExecution = {
    ...mockExecution,
    agents: [
      {
        ...baseAgent,
        status: opts.agentStatus,
        currentRunId: opts.runStatus === "running" ? "r1" : null,
      },
    ],
    runs: [{ ...baseRun, status: opts.runStatus }],
  };
}

function wrap(ui: ReactElement) {
  return render(
    <TooltipProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </TooltipProvider>,
  );
}

describe("RunDetailBody member stop", () => {
  beforeEach(() => {
    submitRunStop.mockReset();
    submitRunStop.mockResolvedValue({ queued: 1 });
    useRunStopPendingStore.getState().reset();
  });

  it("shows stop for pending (queued) without live output banner", () => {
    seed({ agentStatus: "idle", runStatus: "pending" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    expect(screen.getByRole("button", { name: "停止这位队员" })).toBeTruthy();
    expect(screen.queryByText(/正在实时输出/)).toBeNull();
    expect(screen.queryByRole("button", { name: "停止整轮" })).toBeNull();
  });

  it("shows stop on the same row as redirect while working", () => {
    seed({ agentStatus: "working", runStatus: "running" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    expect(screen.getByRole("button", { name: "停止这位队员" })).toBeTruthy();
    expect(screen.getByText(/正在实时输出/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止整轮" })).toBeTruthy();
  });

  it("hides stop for settled runs", () => {
    seed({ agentStatus: "completed", runStatus: "completed" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    expect(screen.queryByRole("button", { name: "停止这位队员" })).toBeNull();
  });

  it("click requests node-scoped stop and disables while pending", async () => {
    seed({ agentStatus: "working", runStatus: "running" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    const btn = screen.getByRole("button", { name: "停止这位队员" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(submitRunStop).toHaveBeenCalledWith("c1", {
        executionId: "exec1",
        runId: "r1",
      });
    });
    const busy = screen.getByRole("button", { name: "停止请求中…" });
    expect(busy).toBeTruthy();
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });
});
