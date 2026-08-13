// @vitest-environment jsdom
/**
 * 写入归因链读起来要像「谁在什么时候把这个文件怎么了」。
 *
 * 回归钉：每行曾渲染等宽的 `file.write` + 英文 `ok`/`denied` + `run 3f2a1b8c`（截断 UUID）。
 * 用户带着「这个文件是谁写的」点进来，拿到一串机器语言，只会得出「这功能不是给我看的」。
 */
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentAuditEvent } from "@/services/audit";
import { type ExecutionPlan, useExecutionStore } from "@/stores/execution";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAuditTrail } from "../FileAuditTrail";

const TURN = "msg-audit";

const plan: ExecutionPlan = {
  id: "exec-audit",
  planType: "multi_agent",
  taskSummary: "写方案",
  agents: [{ id: "w1", role: "研究员" }],
  runs: [{ id: "run-3f2a1b8c", agentId: "w1", task: "写方案", dependsOn: [] }],
};

function event(over: Partial<AgentAuditEvent>): AgentAuditEvent {
  return {
    id: "a1",
    turn_id: TURN,
    trace_id: null,
    execution_id: "exec-audit",
    run_id: "run-3f2a1b8c",
    parent_run_id: null,
    seq: 1,
    category: "tool",
    action: "tool.file_write",
    actor_kind: "member",
    target_type: "file",
    target_ref: "docs/方案.md",
    outcome: "ok",
    detail: {},
    created_at: "2026-08-13T09:41:00Z",
    ...over,
  };
}

function renderTrail(events: AgentAuditEvent[]) {
  return render(
    <TooltipProvider>
      <FileAuditTrail state={{ status: "ready", events }} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useExecutionStore.setState({ byId: {} });
  useExecutionStore.getState().startExecution(plan, TURN);
});

afterEach(cleanup);

describe("写入归因链 · 说人话", () => {
  it("动作与结果是中文，不出现 file.write / ok / run 截断 id", () => {
    renderTrail([event({})]);
    expect(screen.getByText("写入")).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
    expect(screen.queryByText(/file_write|file\.write/)).toBeNull();
    expect(screen.queryByText(/^ok$/)).toBeNull();
    expect(screen.queryByText(/3f2a1b8c/)).toBeNull();
  });

  it("「谁写的」落协作图上的角色名", () => {
    renderTrail([event({})]);
    expect(screen.getByText("研究员")).toBeTruthy();
  });

  it("查不到协作图时退回主管 / 队员，仍不摆 run id", () => {
    useExecutionStore.setState({ byId: {} });
    renderTrail([
      event({ run_id: "run-unknown", actor_kind: "captain" }),
      event({ id: "a2", run_id: "run-other", actor_kind: "member" }),
    ]);
    expect(screen.getByText("主管")).toBeTruthy();
    expect(screen.getByText("队员")).toBeTruthy();
    expect(screen.queryByText(/run-unknown|run-other/)).toBeNull();
  });

  it("失败 / 被拒有各自的中文结果", () => {
    renderTrail([
      event({ id: "f1", outcome: "failed" }),
      event({ id: "f2", action: "tool.str_replace", outcome: "denied" }),
    ]);
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("已拒绝")).toBeTruthy();
    expect(screen.getByText("修改")).toBeTruthy();
  });

  it("审批 / 占用类动作自带结果语义，不再叠一个「成功」", () => {
    renderTrail([
      event({ id: "p1", category: "approval", action: "approval.granted" }),
      event({
        id: "p2",
        category: "permission",
        action: "permission.write_conflict",
        outcome: "denied",
      }),
    ]);
    expect(screen.getByText("你批准了这次操作")).toBeTruthy();
    expect(screen.getByText("另一名队员正占用写权")).toBeTruthy();
    expect(screen.queryByText("成功")).toBeNull();
  });

  it("后端新增的动作退化成类别词，绝不把内部动作串摆出来", () => {
    renderTrail([event({ action: "tool.file_batch_v2" })]);
    expect(screen.getByText("文件操作")).toBeTruthy();
    expect(screen.queryByText(/file_batch_v2/)).toBeNull();
  });
});
