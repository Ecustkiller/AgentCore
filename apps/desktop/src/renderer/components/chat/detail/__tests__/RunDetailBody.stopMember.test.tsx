// @vitest-environment jsdom
/**
 * RunDetailBody 按人干预入口：队员那一路任何状态都在（跑完了就变灰 + 说明原因，绝不消失）；
 * 点击走 requestRunStop；请求中禁用。
 *
 * 两条诚实边界一并钉在这里：受理与否由服务端回答（引擎够不着时不留「停止请求中…」），
 * 以及 captain 那一路不出按人干预（主管就是这条对话本身，「只停这位队员」对它无意义）。
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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

/** 引擎受理了这次停止（服务端回执的正常形）。 */
const ACCEPTED = {
  queued: 1,
  accepted: true,
  reason: "queued",
  detail: "已交给引擎：正在停这位队员。",
};

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
  runKind?: RunNode["kind"];
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
    runs: [
      { ...baseRun, status: opts.runStatus, kind: opts.runKind ?? "agent" },
    ],
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
    submitRunStop.mockResolvedValue(ACCEPTED);
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

  // 跑完的队员确实停不了也改不了，但入口消失会让用户以为自己找错了地方——扑空一次
  // 就再也不来，最后只敢用够得着的「停止整轮」。所以变灰 + 说清为什么，不隐藏。
  it("keeps both entries visible but disabled with a reason once settled", () => {
    seed({ agentStatus: "completed", runStatus: "completed" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    const stop = screen.getByRole("button", {
      name: /^停止这位队员（/,
    }) as HTMLButtonElement;
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.title).toMatch(/已经跑完/);

    const redirect = screen.getByRole("button", {
      name: /^立即改此人（/,
    }) as HTMLButtonElement;
    expect(redirect.getAttribute("aria-disabled")).toBe("true");
    expect(redirect.title).toMatch(/已经跑完/);

    // 原因也写在面板上，不必等 hover 才知道为什么点不动。
    expect(screen.getByText(/这位队员已经跑完/)).toBeTruthy();
  });

  it("blocks stop clicks once settled (no request goes out)", () => {
    seed({ agentStatus: "completed", runStatus: "completed" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    fireEvent.click(screen.getByRole("button", { name: /^停止这位队员（/ }));
    expect(submitRunStop).not.toHaveBeenCalled();
  });

  it("explains that a queued member has no in-flight work to redirect", () => {
    seed({ agentStatus: "idle", runStatus: "pending" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    // 排队中可停（可用），但没有在跑的工作可改（不可用 + 原因）。
    expect(screen.getByRole("button", { name: "停止这位队员" })).toBeTruthy();
    const redirect = screen.getByRole("button", { name: /^立即改此人（/ });
    expect(redirect.getAttribute("aria-disabled")).toBe("true");
    expect(redirect.getAttribute("title")).toMatch(/还没开工/);
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

  // 服务端说够不着（驱动已退出 / run 不在当前计划里）时**什么都没入队**。留一个
  // 「停止请求中…」在屏上就是替引擎撒谎——用户会一直等一个永远不来的确认。
  it("keeps no in-flight state when the engine says it cannot reach the run", async () => {
    submitRunStop.mockResolvedValue({
      queued: 0,
      accepted: false,
      reason: "no_live_drive",
      detail: "这批工作已经不在引擎手里了，没有能停的在跑队员。",
    });
    seed({ agentStatus: "working", runStatus: "running" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    fireEvent.click(screen.getByRole("button", { name: "停止这位队员" }));

    await waitFor(() => {
      expect(submitRunStop).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "停止请求中…" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "停止这位队员" })).toBeTruthy();
    expect(useRunStopPendingStore.getState().isRunCovered("exec1", "r1")).toBe(
      false,
    );
  });

  // captain 不是被派出去的队员——引擎的计划里没有它，「只停这位队员」必然落空。
  // 但回合级的「停止整轮」仍在，用户要停有地方停（手机早已是这个判据）。
  it("hides per-member intervene on the captain run, keeps 停止整轮", () => {
    seed({ agentStatus: "working", runStatus: "running", runKind: "captain" });
    wrap(<RunDetailBody messageId="m1" runId="r1" />);

    expect(screen.queryByRole("button", { name: /停止这位队员/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /立即改此人/ })).toBeNull();
    expect(screen.getByRole("button", { name: "停止整轮" })).toBeTruthy();
  });
});
