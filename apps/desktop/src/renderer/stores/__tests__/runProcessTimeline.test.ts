import { type ExecutionPlan, projectExecution } from "@/stores/execution";
import type { RunFrame } from "@/stores/execution";
import { describe, expect, it } from "vitest";

const plan: ExecutionPlan = {
  id: "exec1",
  planType: "multi_agent",
  taskSummary: "调研",
  agents: [
    {
      id: "w1",
      role: "调研员",
      thinking: true,
    },
  ],
  runs: [
    {
      id: "r1",
      agentId: "w1",
      task: "调研竞品",
      dependsOn: [],
    },
  ],
};

describe("worker run process timeline fold", () => {
  it("interleaves reasoning → tool → content on RunNode.process", () => {
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
        kind: "run_reasoning_delta",
        runId: "r1",
        agentId: "w1",
        delta: "先搜。",
      },
      {
        t: 3,
        kind: "tool_use_start",
        toolCallId: "tc1",
        toolName: "web_search",
        arguments: { query: "x" },
        runId: "r1",
      },
      {
        t: 4,
        kind: "tool_use_end",
        toolCallId: "tc1",
        result: "ok",
        display: null,
        status: "success",
      },
      {
        t: 5,
        kind: "run_output_delta",
        runId: "r1",
        agentId: "w1",
        delta: "结论。",
      },
    ];
    const exec = projectExecution(plan, frames, "running");
    const run = exec.runs.find((r) => r.id === "r1");
    expect(run?.process.map((s) => s.kind)).toEqual([
      "reasoning",
      "tool",
      "content",
    ]);
    expect(run?.process[0]).toMatchObject({
      kind: "reasoning",
      text: "先搜。",
    });
    expect(run?.process[1]).toMatchObject({
      kind: "tool",
      id: "tc1",
      status: "success",
      result: "ok",
    });
    expect(run?.process[2]).toMatchObject({
      kind: "content",
      text: "结论。",
    });
  });

  // attach 增量重放的帧级替换（`replace`）：重放段里「还没说完的那一步」带的是整步全文。
  // 换掉的只能是末尾那个尚未闭合的块——前面已闭合的步骤一个不动，chunks 拼接值（产出全文 /
  // 尾部预览的唯一来源）与步骤数组保持一致。
  it("replaces the open output block instead of appending (attach 增量重放)", () => {
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
        kind: "run_output_delta",
        runId: "r1",
        agentId: "w1",
        delta: "第一段结论。",
      },
      {
        t: 3,
        kind: "run_reasoning_delta",
        runId: "r1",
        agentId: "w1",
        delta: "再核一下",
      },
      {
        t: 4,
        kind: "run_output_delta",
        runId: "r1",
        agentId: "w1",
        delta: "半句还没",
      },
      {
        t: 5,
        kind: "run_output_delta",
        runId: "r1",
        agentId: "w1",
        delta: "半句还没说完，这是整步全文。",
        replace: true,
      },
    ];
    const exec = projectExecution(plan, frames, "running");
    const run = exec.runs.find((r) => r.id === "r1");
    expect(run?.process).toEqual([
      { kind: "content", text: "第一段结论。" },
      { kind: "reasoning", text: "再核一下" },
      { kind: "content", text: "半句还没说完，这是整步全文。" },
    ]);
    const agent = exec.agents.find((a) => a.id === "w1");
    expect(agent?.outputChunks.join("")).toBe(
      "第一段结论。半句还没说完，这是整步全文。",
    );
    expect(agent?.reasoningChunks.join("")).toBe("再核一下");
  });

  it("replaces the open reasoning block instead of appending", () => {
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
        kind: "run_reasoning_delta",
        runId: "r1",
        agentId: "w1",
        delta: "先拆解。",
      },
      {
        t: 3,
        kind: "run_output_delta",
        runId: "r1",
        agentId: "w1",
        delta: "初步结论。",
      },
      {
        t: 4,
        kind: "run_reasoning_delta",
        runId: "r1",
        agentId: "w1",
        delta: "想到一半",
      },
      {
        t: 5,
        kind: "run_reasoning_delta",
        runId: "r1",
        agentId: "w1",
        delta: "想到一半，这是整步全文。",
        replace: true,
      },
    ];
    const exec = projectExecution(plan, frames, "running");
    const run = exec.runs.find((r) => r.id === "r1");
    expect(run?.process).toEqual([
      { kind: "reasoning", text: "先拆解。" },
      { kind: "content", text: "初步结论。" },
      { kind: "reasoning", text: "想到一半，这是整步全文。" },
    ]);
    const agent = exec.agents.find((a) => a.id === "w1");
    expect(agent?.reasoningChunks.join("")).toBe(
      "先拆解。想到一半，这是整步全文。",
    );
    expect(agent?.outputChunks.join("")).toBe("初步结论。");
  });
});
