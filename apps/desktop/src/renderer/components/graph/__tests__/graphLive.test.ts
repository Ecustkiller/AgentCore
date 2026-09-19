import {
  agentNodeFaceIsStreaming,
  agentNodeLiveInstantSig,
  agentNodeLiveSig,
  deriveAgentNodeLive,
} from "@/components/graph/graphLive";
import type { GraphScene } from "@/components/graph/scene";
import type { AgentState, Execution, RunNode } from "@/stores/execution";
import { describe, expect, it } from "vitest";

function run(
  partial: Partial<RunNode> & Pick<RunNode, "id" | "status" | "agentId">,
): RunNode {
  return {
    task: "t",
    dependsOn: [],
    parentRunId: null,
    kind: "agent",
    role: null,
    model: null,
    reasoningEffort: null,
    usage: null,
    cost: null,
    error: null,
    outputSummary: null,
    outputFiles: [],
    debrief: null,
    durationMs: null,
    startedAt: null,
    stance: null,
    group: null,
    round: 0,
    continuesRunId: null,
    continuationIndex: 0,
    replacesRunId: null,
    revised: null,
    checkpoint: null,
    receivedContext: [],
    escalations: [],
    process: [],
    sideKey: null,
    ...partial,
  };
}

function continuationCtx(body: string): RunNode["receivedContext"] {
  return [
    {
      channel: "continuation",
      heading: "continuation",
      body,
      chars: body.length,
      truncated: false,
      source_role: "",
      source_run_id: "",
      fidelity: "",
      files: [],
    },
  ];
}

function agent(
  partial: Partial<AgentState> & Pick<AgentState, "id" | "role">,
): AgentState {
  return {
    thinking: false,
    status: "idle",
    currentRunId: null,
    outputChunks: [],
    reasoningChunks: [],
    toolCalls: [],
    toolProgress: null,
    toolExecutionLive: null,
    ...partial,
  };
}

function exec(partial: {
  agents: AgentState[];
  runs: RunNode[];
  status?: Execution["status"];
}): Execution {
  return {
    id: "e1",
    planType: "multi_agent",
    taskSummary: "并行调研",
    status: partial.status ?? "running",
    agents: partial.agents,
    runs: partial.runs,
    progress: {
      completed: partial.runs.filter((r) => r.status === "completed").length,
      total: partial.runs.length,
    },
    acts: [],
    batches: [],
    debate: null,
    debateRounds: [],
    crossExamEnabled: false,
    debateOpening: null,
  };
}

const deriveOpts = {
  scene: null,
  litRunId: null,
  enterIndex: 0,
  unitExpanded: false,
};

describe("agentNodeLiveSig", () => {
  it("stays equal when another agent streams deltas", () => {
    const base = exec({
      agents: [
        agent({
          id: "a1",
          role: "研究员",
          status: "completed",
          outputChunks: ["done"],
        }),
        agent({
          id: "a2",
          role: "分析师",
          status: "working",
          currentRunId: "r2",
          outputChunks: ["x"],
        }),
      ],
      runs: [
        run({ id: "r1", agentId: "a1", status: "completed" }),
        run({ id: "r2", agentId: "a2", status: "running" }),
      ],
    });
    const idleSig = agentNodeLiveSig(base, "r1");
    const next: Execution = {
      ...base,
      agents: base.agents.map((a) =>
        a.id === "a2"
          ? { ...a, outputChunks: [...a.outputChunks, "more-tokens-here"] }
          : a,
      ),
    };
    expect(agentNodeLiveSig(next, "r1")).toBe(idleSig);
    expect(agentNodeLiveSig(next, "r2")).not.toBe(agentNodeLiveSig(base, "r2"));
    expect(agentNodeLiveInstantSig(next, "r2")).toBe(
      agentNodeLiveInstantSig(base, "r2"),
    );
    expect(agentNodeFaceIsStreaming(next, "r2")).toBe(true);
    expect(agentNodeFaceIsStreaming(next, "r1")).toBe(false);
  });

  it("changes when tool_use_end flips status without changing toolCalls.length", () => {
    const runningTc = {
      id: "tc1",
      toolName: "read_file",
      arguments: {},
      result: null,
      status: "running" as const,
    };
    const base = exec({
      agents: [
        agent({
          id: "a1",
          role: "研究员",
          status: "working",
          currentRunId: "r1",
          toolCalls: [runningTc],
        }),
      ],
      runs: [run({ id: "r1", agentId: "a1", status: "running" })],
    });
    const before = agentNodeLiveSig(base, "r1");
    const agent0 = base.agents[0];
    expect(agent0).toBeDefined();
    if (!agent0) throw new Error("expected agent");
    const after: Execution = {
      ...base,
      agents: [
        {
          ...agent0,
          toolCalls: [
            {
              ...runningTc,
              status: "success",
              result: "ok",
            },
          ],
        },
      ],
    };
    expect(agentNodeLiveSig(after, "r1")).not.toBe(before);
    expect(agentNodeLiveInstantSig(after, "r1")).not.toBe(
      agentNodeLiveInstantSig(base, "r1"),
    );
  });

  it("instant sig ignores tool char floods but follows tool name", () => {
    const base = exec({
      agents: [
        agent({
          id: "a1",
          role: "研究员",
          status: "working",
          currentRunId: "r1",
          toolProgress: { toolName: "file_write", chars: 12 },
        }),
      ],
      runs: [run({ id: "r1", agentId: "a1", status: "running" })],
    });
    const agent0 = base.agents[0];
    expect(agent0).toBeDefined();
    if (!agent0) throw new Error("expected agent");
    const moreChars: Execution = {
      ...base,
      agents: [
        {
          ...agent0,
          toolProgress: { toolName: "file_write", chars: 4800 },
        },
      ],
    };
    const otherTool: Execution = {
      ...base,
      agents: [
        {
          ...agent0,
          toolProgress: { toolName: "grep", chars: 12 },
        },
      ],
    };
    expect(agentNodeLiveInstantSig(moreChars, "r1")).toBe(
      agentNodeLiveInstantSig(base, "r1"),
    );
    expect(agentNodeLiveInstantSig(otherTool, "r1")).not.toBe(
      agentNodeLiveInstantSig(base, "r1"),
    );
  });
});

describe("deriveAgentNodeLive", () => {
  it("builds outputPreview from chunk tails without needing a full join shape", () => {
    const prefix = "α".repeat(200);
    const tail = "最新一句在末尾可见";
    const execution = exec({
      agents: [
        agent({
          id: "a1",
          role: "研究员",
          status: "working",
          currentRunId: "r1",
          outputChunks: [prefix, tail],
        }),
      ],
      runs: [run({ id: "r1", agentId: "a1", status: "running" })],
    });
    const faceRun = execution.runs[0];
    expect(faceRun).toBeDefined();
    if (!faceRun) throw new Error("expected run");
    const face = deriveAgentNodeLive(execution, faceRun, deriveOpts);
    expect(face.outputPreview).toContain(tail);
    expect(face.outputPreview.length).toBeLessThanOrEqual(81);
    expect(face.tokenCount).toBeGreaterThan(0);
  });

  it("does not flag review-concern from free-text output", () => {
    const text = "综合评分 4/10，整体方向偏了，建议重写。";
    const execution = exec({
      agents: [
        agent({
          id: "a1",
          role: "学术审校员",
          status: "completed",
          outputChunks: [text],
        }),
      ],
      runs: [run({ id: "r1", agentId: "a1", status: "completed" })],
    });
    const faceRun = execution.runs[0];
    expect(faceRun).toBeDefined();
    if (!faceRun) throw new Error("expected run");
    const face = deriveAgentNodeLive(execution, faceRun, deriveOpts);
    expect(face).not.toHaveProperty("reviewConcern");
    expect(face.outputPreview).toContain("建议重写");
  });

  it("seat fold follows continuation tail status and output", () => {
    const execution = exec({
      agents: [
        agent({
          id: "a1",
          role: "计时测试员",
          status: "idle",
          outputChunks: ["old"],
        }),
        agent({
          id: "a2",
          role: "计时测试员",
          status: "working",
          currentRunId: "r1b",
          outputChunks: ["new-tail"],
        }),
      ],
      runs: [
        run({ id: "r1", agentId: "a1", status: "cancelled" }),
        run({
          id: "r1b",
          agentId: "a2",
          status: "running",
          continuesRunId: "r1",
          continuationIndex: 1,
          receivedContext: continuationCtx("取消"),
        }),
      ],
    });
    const host = execution.runs[0];
    expect(host).toBeDefined();
    if (!host) throw new Error("expected host");
    const scene = {
      seatFoldsByHost: new Map([["r1", ["r1b"]]]),
      beatFoldsByHost: new Map(),
      fold: {
        descendants: new Map(),
        debateUnits: new Set(),
        folded: new Set(),
        unitOf: new Map(),
      },
    } as unknown as GraphScene;
    const face = deriveAgentNodeLive(execution, host, { ...deriveOpts, scene });
    expect(face.status).toBe("running");
    expect(face.runId).toBe("r1");
    expect(face.outputPreview).toContain("new-tail");
    expect(face.isRevision).toBe(true);
    expect(face.continuationIndex).toBe(1);
    expect(face.revisionSummary).toBe("取消");
  });
});
