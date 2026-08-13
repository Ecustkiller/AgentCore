// @vitest-environment jsdom
/**
 * 节点上的按人干预条 —— 「只改这个人的方向 / 只停这个人」提到用户正在看的那张卡上。
 *
 * 钉住的核心是**不许静默消失**：队员跑完之后这两件事确实做不到，但入口一旦不见，
 * 用户会以为自己找错了地方，从此只用够得着的「停止整轮」。所以终局态必须仍在，
 * 只是变灰 + 说清为什么。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type ExecutionPlan,
  ExecutionScopeContext,
  type RunFrame,
  useExecutionStore,
} from "@/stores/execution";
import { useRunStopPendingStore } from "@/stores/runStopPending";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNodeInterveneBar } from "../agentNode/AgentNodeInterveneBar";
import type { AgentNodeData } from "../agentNode/shared";

const MID = "msg-intervene";
const CID = "conv-intervene";

const submitRunStop = vi.fn();
const submitRunRedirect = vi.fn();

vi.mock("@/services/runStop", () => ({
  submitRunStop: (...args: unknown[]) => submitRunStop(...args),
}));

vi.mock("@/services/runRedirect", () => ({
  submitRunRedirect: (...args: unknown[]) => submitRunRedirect(...args),
}));

vi.mock("@/stores/conversation", () => ({
  useConversationStore: (
    sel: (s: { currentConversationId: string }) => unknown,
  ) => sel({ currentConversationId: CID }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

/** 引擎受理了这次干预（服务端回执的正常形）。 */
const ACCEPTED = { queued: 1, accepted: true, reason: "queued", detail: "" };

const plan: ExecutionPlan = {
  id: "exec-intervene",
  planType: "multi_agent",
  taskSummary: "并行调研",
  agents: [{ id: "w1", role: "研究员" }],
  runs: [{ id: "r1", agentId: "w1", task: "调研", dependsOn: [] }],
};

const started: RunFrame = {
  t: 1,
  kind: "run_started",
  runId: "r1",
  agentId: "w1",
  parentRunId: null,
  runKind: "agent",
  continuesRunId: null,
};

function seed(opts: { completed?: boolean } = {}) {
  useExecutionStore.setState({ byId: {} });
  useExecutionStore.getState().startExecution(plan, MID);
  useExecutionStore.getState().recordFrame(started, MID);
  if (opts.completed) {
    useExecutionStore.getState().recordFrame(
      {
        t: 2,
        kind: "run_completed",
        runId: "r1",
        agentId: "w1",
        outputSummary: "写完了",
        durationMs: 10,
      },
      MID,
    );
  }
}

function nodeData(overrides: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    agentId: "w1",
    role: "研究员",
    runId: "r1",
    status: "running",
    isAnimating: true,
    task: "调研",
    outputPreview: "",
    tokenCount: 0,
    toolCount: 0,
    // 右坞钉住这张卡 = 「节点选中态」，干预条据此常驻（悬停是另一条同效路径）。
    focused: true,
    ...overrides,
  };
}

function renderBar(d: AgentNodeData = nodeData()) {
  return render(
    <TooltipProvider>
      <ExecutionScopeContext.Provider value={MID}>
        <AgentNodeInterveneBar d={d} />
      </ExecutionScopeContext.Provider>
    </TooltipProvider>,
  );
}

describe("AgentNodeInterveneBar", () => {
  beforeEach(() => {
    submitRunStop.mockReset();
    submitRunStop.mockResolvedValue(ACCEPTED);
    submitRunRedirect.mockReset();
    submitRunRedirect.mockResolvedValue(ACCEPTED);
    useRunStopPendingStore.getState().reset();
    seed();
  });

  afterEach(cleanup);

  it("puts both per-person actions on the selected node, one click from the graph", () => {
    renderBar();

    expect(screen.getByRole("button", { name: "立即改此人" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止这位队员" })).toBeTruthy();
  });

  it("stays out of the way until the node has attention", () => {
    renderBar(nodeData({ focused: false }));

    expect(screen.queryByRole("button", { name: "立即改此人" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停止这位队员" })).toBeNull();
  });

  it("keeps both entries visible but disabled with a reason once the member is done", () => {
    seed({ completed: true });
    renderBar(nodeData({ status: "completed", isAnimating: false }));

    const redirect = screen.getByRole("button", { name: /^立即改此人（/ });
    expect(redirect.getAttribute("aria-disabled")).toBe("true");
    expect(redirect.getAttribute("title")).toMatch(/已经跑完/);

    const stop = screen.getByRole("button", { name: /^停止这位队员（/ });
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.getAttribute("title")).toMatch(/已经跑完/);
  });

  it("does not fire requests from the disabled entries", () => {
    seed({ completed: true });
    renderBar(nodeData({ status: "completed", isAnimating: false }));

    fireEvent.click(screen.getByRole("button", { name: /^停止这位队员（/ }));
    fireEvent.click(screen.getByRole("button", { name: /^立即改此人（/ }));

    expect(submitRunStop).not.toHaveBeenCalled();
    expect(submitRunRedirect).not.toHaveBeenCalled();
  });

  it("stops just this member from the node (turn keeps running)", async () => {
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "停止这位队员" }));

    await waitFor(() => {
      expect(submitRunStop).toHaveBeenCalledWith(CID, {
        executionId: "exec-intervene",
        runId: "r1",
      });
    });
    // 不假装已停：run 状态仍是 running，只把按钮切到「请求中」。
    expect(screen.getByRole("button", { name: "停止请求中…" })).toBeTruthy();
    expect(useExecutionStore.getState().byId[MID]?.status).toBe("running");
  });

  it("submits a redirect for this member without leaving the graph", async () => {
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "立即改此人" }));

    const box = await screen.findByPlaceholderText("具体、可执行的修改方向…");
    fireEvent.change(box, { target: { value: "改用公开财报数据" } });
    fireEvent.click(screen.getByRole("button", { name: "提交改方向" }));

    await waitFor(() => {
      expect(submitRunRedirect).toHaveBeenCalledWith(CID, {
        executionId: "exec-intervene",
        runId: "r1",
        feedback: "改用公开财报数据",
      });
    });
  });

  // 团队转后台执行时「气泡还在流吗」与「引擎够不够得着」是两件事：这里节点仍在跑，
  // 服务端此刻照样能排干 redirect。以前画布看整条执行是否收口，于是同一个 run 在
  // 画布上「可以改方向」、在右坞上「这一轮已经结束了」——两边都在猜。
  it("still offers redirect after the turn bubble settled (engine answers reachability)", () => {
    useExecutionStore.setState((s) => ({
      byId: { ...s.byId, [MID]: { ...s.byId[MID], status: "completed" } },
    }));
    renderBar();

    const redirect = screen.getByRole("button", { name: "立即改此人" });
    expect(redirect.getAttribute("aria-disabled")).toBeNull();
  });

  // 服务端说够不着 → 什么都没入队，不许留一个「停止请求中…」在卡上。
  it("drops the in-flight state when the engine refuses the stop", async () => {
    submitRunStop.mockResolvedValue({
      queued: 0,
      accepted: false,
      reason: "unknown_run",
      detail: "引擎当前的计划里没有这位队员，停不到他。",
    });
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "停止这位队员" }));

    await waitFor(() => {
      expect(submitRunStop).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "停止请求中…" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "停止这位队员" })).toBeTruthy();
  });
});
