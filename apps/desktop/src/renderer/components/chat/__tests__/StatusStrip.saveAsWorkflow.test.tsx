// @vitest-environment jsdom
/**
 * 「存为工作流」入口（工作流主入口）——只在刚跑完的多队员协作那一刻出现。
 * 单队员 / 硬停回合不出；存过之后按钮改态并如实转述服务端的降级说明。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import { conversationKeys } from "@/lib/queryKeys";
import { saveTurnAsWorkflow } from "@/services/workflows";
import { useConversationStore } from "@/stores/conversation";
import {
  type ExecutionPlan,
  ExecutionScopeContext,
  type RunFrame,
  projectExecution,
  useExecutionStore,
} from "@/stores/execution";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusStrip } from "../StatusStrip";

vi.mock("@/services/workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/workflows")>();
  return { ...actual, saveTurnAsWorkflow: vi.fn() };
});

const saveMock = vi.mocked(saveTurnAsWorkflow);

const MID = "msg-save-as-workflow";
const CID = "conv-save-as-workflow";

const teamPlan: ExecutionPlan = {
  id: "exec-team",
  planType: "multi_agent",
  taskSummary: "并行调研竞品",
  agents: [
    { id: "w1", role: "研究员" },
    { id: "w2", role: "撰写员" },
  ],
  runs: [
    { id: "r1", agentId: "w1", task: "调研", dependsOn: [] },
    { id: "r2", agentId: "w2", task: "撰写", dependsOn: ["r1"] },
  ],
};

const soloPlan: ExecutionPlan = {
  id: "exec-solo",
  planType: "multi_agent",
  taskSummary: "一个人干完",
  agents: [{ id: "w1", role: "研究员" }],
  runs: [{ id: "r1", agentId: "w1", task: "调研", dependsOn: [] }],
};

function started(
  t: number,
  runId: string,
  agentId: string,
  parentRunId: string | null = null,
): RunFrame {
  return {
    t,
    kind: "run_started",
    runId,
    agentId,
    parentRunId,
    runKind: "agent",
    continuesRunId: null,
  };
}

function completed(t: number, runId: string, agentId: string): RunFrame {
  return {
    t,
    kind: "run_completed",
    runId,
    agentId,
    outputSummary: "done",
    durationMs: 100,
  };
}

const teamFrames: RunFrame[] = [
  started(1, "r1", "w1"),
  completed(2, "r1", "w1"),
  started(3, "r2", "w2"),
  completed(4, "r2", "w2"),
];

const soloFrames: RunFrame[] = [
  started(1, "r1", "w1"),
  completed(2, "r1", "w1"),
];

const debateAgents: ExecutionPlan["agents"] = [
  { id: "mod", role: "主持人" },
  { id: "d_pro", role: "支持方" },
  { id: "d_con", role: "反对方" },
];

/**
 * 辩论（真实向量形状）：主持人与首轮正反辩手都是 kind=agent 的冷开局节点，光数人头
 * 就是 3 个。但辩论席位从不落 `plan_snapshot`，服务端固化不到——按人头放行等于诱导
 * 用户点一个必定 422 的按钮。
 */
const debateRuns: ExecutionPlan["runs"] = [
  { id: "mod", agentId: "mod", task: "主持正反辩论", dependsOn: [] },
  {
    id: "mod_r1_pro",
    agentId: "d_pro",
    task: "论证支持采用方案 A",
    dependsOn: [],
    parentRunId: "mod",
    stance: "pro",
    group: "debate:debate",
    round: 1,
  },
  {
    id: "mod_r1_con",
    agentId: "d_con",
    task: "论证反对采用方案 A",
    dependsOn: [],
    parentRunId: "mod",
    stance: "con",
    group: "debate:debate",
    round: 1,
  },
];

const debatePlan: ExecutionPlan = {
  id: "exec-debate",
  planType: "debate",
  taskSummary: "该不该上方案 A",
  agents: debateAgents,
  runs: debateRuns,
};

const debateFrames: RunFrame[] = [
  started(1, "mod", "mod"),
  started(2, "mod_r1_pro", "d_pro", "mod"),
  completed(3, "mod_r1_pro", "d_pro"),
  started(4, "mod_r1_con", "d_con", "mod"),
  completed(5, "mod_r1_con", "d_con"),
  completed(6, "mod", "mod"),
];

/** 本轮既派了单又打了辩论：服务端存得下 delegate 那半，入口照常。 */
const mixedPlan: ExecutionPlan = {
  id: "exec-mixed",
  planType: "multi_agent",
  taskSummary: "辩完再落地",
  agents: [...debateAgents, ...teamPlan.agents],
  runs: [...debateRuns, ...teamPlan.runs],
};

const mixedFrames: RunFrame[] = [
  ...debateFrames,
  started(7, "r1", "w1"),
  completed(8, "r1", "w1"),
  started(9, "r2", "w2"),
  completed(10, "r2", "w2"),
];

const savedWorkflow = {
  id: "wf-77",
  name: "并行调研竞品",
  description: "由对话回合快照生成；已降级字段：tools, max_rounds",
  definition: { nodes: [], edges: [] },
  // 出处由服务端写在工作流顶层：就是刚存的这一轮。
  source: { kind: "turn", conversationId: CID, messageId: MID },
  version: 1,
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-13T00:00:00Z",
};

function renderStrip(
  execution: ReturnType<typeof projectExecution>,
  stopped = false,
) {
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
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ExecutionScopeContext.Provider value={MID}>
            <StatusStrip
              execution={{
                ...execution,
                status: stopped ? "cancelled" : execution.status,
              }}
              expanded
              onToggle={() => {}}
              onMaximize={() => {}}
              onReplay={() => {}}
            />
          </ExecutionScopeContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  saveMock.mockReset();
  useExecutionStore.setState({ byId: {} });
  useConversationStore.setState({ currentConversationId: CID });
});

afterEach(() => {
  cleanup();
  useConversationStore.setState({ currentConversationId: null });
});

describe("StatusStrip · 存为工作流入口", () => {
  it("多队员完成态露出入口", () => {
    useExecutionStore.getState().startExecution(teamPlan, MID);
    renderStrip(projectExecution(teamPlan, teamFrames, "completed"));
    expect(screen.getByTestId("status-strip-save-as-workflow")).toBeTruthy();
    expect(screen.getByText("存为工作流")).toBeTruthy();
  });

  it("单队员回合不出入口（没有可复用的分工）", () => {
    useExecutionStore.getState().startExecution(soloPlan, MID);
    renderStrip(projectExecution(soloPlan, soloFrames, "completed"));
    expect(screen.queryByTestId("status-strip-save-as-workflow")).toBeNull();
  });

  it("纯辩论回合不出入口（辩论席位不落计划快照，点了必 422）", () => {
    useExecutionStore.getState().startExecution(debatePlan, MID);
    renderStrip(projectExecution(debatePlan, debateFrames, "completed"));
    expect(screen.queryByTestId("status-strip-save-as-workflow")).toBeNull();
  });

  it("辩论幕内附属 run 不顶队员人头（主持人名下整棵子树都不算）", () => {
    // 老 journal 的庭前取证 run 挂在主持人名下，且不带辩论标记（`pretrial:` 命名空间）。
    const plan: ExecutionPlan = {
      ...debatePlan,
      agents: [...debateAgents, { id: "inv", role: "取证员" }],
      runs: [
        ...debateRuns,
        {
          id: "mod_pretrial_0",
          agentId: "inv",
          task: "庭前取证",
          dependsOn: [],
          parentRunId: "mod",
          group: "pretrial:investigators:0",
        },
      ],
    };
    useExecutionStore.getState().startExecution(plan, MID);
    renderStrip(
      projectExecution(
        plan,
        [
          ...debateFrames,
          started(7, "mod_pretrial_0", "inv", "mod"),
          completed(8, "mod_pretrial_0", "inv"),
        ],
        "completed",
      ),
    );
    expect(screen.queryByTestId("status-strip-save-as-workflow")).toBeNull();
  });

  it("混合回合照常出入口（delegate 那半存得下）", () => {
    useExecutionStore.getState().startExecution(mixedPlan, MID);
    renderStrip(projectExecution(mixedPlan, mixedFrames, "completed"));
    expect(screen.getByTestId("status-strip-save-as-workflow")).toBeTruthy();
  });

  it("辩论 + 单个队员不出入口（主持人不补足队员人头）", () => {
    const plan: ExecutionPlan = {
      ...mixedPlan,
      agents: [...debateAgents, soloPlan.agents[0]],
      runs: [...debateRuns, soloPlan.runs[0]],
    };
    useExecutionStore.getState().startExecution(plan, MID);
    renderStrip(
      projectExecution(
        plan,
        [...debateFrames, started(7, "r1", "w1"), completed(8, "r1", "w1")],
        "completed",
      ),
    );
    expect(screen.queryByTestId("status-strip-save-as-workflow")).toBeNull();
  });

  it("硬停回合不出入口（不是「满意的一轮」）", () => {
    useExecutionStore.getState().startExecution(teamPlan, MID);
    renderStrip(projectExecution(teamPlan, teamFrames, "cancelled"), true);
    expect(screen.getByText("已停止")).toBeTruthy();
    expect(screen.queryByTestId("status-strip-save-as-workflow")).toBeNull();
  });

  it("没有当前对话时不出入口（拿不到 conversation_id）", () => {
    useConversationStore.setState({ currentConversationId: null });
    useExecutionStore.getState().startExecution(teamPlan, MID);
    renderStrip(projectExecution(teamPlan, teamFrames, "completed"));
    expect(screen.queryByTestId("status-strip-save-as-workflow")).toBeNull();
  });

  it("命名保存 → 转述降级说明，按钮改「已存为工作流」", async () => {
    saveMock.mockResolvedValueOnce(savedWorkflow);
    useExecutionStore.getState().startExecution(teamPlan, MID);
    renderStrip(projectExecution(teamPlan, teamFrames, "completed"));

    fireEvent.click(screen.getByTestId("status-strip-save-as-workflow"));
    const input = screen.getByLabelText("名称（可选）") as HTMLInputElement;
    expect(input.value).toBe("并行调研竞品");
    fireEvent.change(input, { target: { value: "竞品调研三步" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByTestId("save-as-workflow-degrade")).toBeTruthy();
    });
    expect(saveMock).toHaveBeenCalledWith(CID, MID, { name: "竞品调研三步" });
    expect(screen.getByTestId("save-as-workflow-degrade").textContent).toBe(
      savedWorkflow.description,
    );
    expect(screen.getByRole("button", { name: "去微调" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "留在对话" }));
    await waitFor(() => {
      expect(screen.getByText("已存为工作流")).toBeTruthy();
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("服务端没带说明时仍讲清快照边界", async () => {
    saveMock.mockResolvedValueOnce({ ...savedWorkflow, description: null });
    useExecutionStore.getState().startExecution(teamPlan, MID);
    renderStrip(projectExecution(teamPlan, teamFrames, "completed"));

    fireEvent.click(screen.getByTestId("status-strip-save-as-workflow"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByTestId("save-as-workflow-degrade")).toBeTruthy();
    });
    expect(
      screen.getByTestId("save-as-workflow-degrade").textContent,
    ).toContain("复跑效果可能与原轮不同");
  });

  it("422（这轮不算多队员协作）走 inline 错误，不改按钮态", async () => {
    const { ApiError } = await import("@/services/api");
    saveMock.mockRejectedValueOnce(
      new ApiError(
        422,
        JSON.stringify({
          error: { code: "INVALID_REQUEST", message: "这轮没有多队员协作" },
        }),
      ),
    );
    useExecutionStore.getState().startExecution(teamPlan, MID);
    renderStrip(projectExecution(teamPlan, teamFrames, "completed"));

    fireEvent.click(screen.getByTestId("status-strip-save-as-workflow"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByTestId("save-as-workflow-error").textContent).toBe(
        "这轮没有多队员协作",
      );
    });
    expect(screen.queryByText("已存为工作流")).toBeNull();
  });
});
