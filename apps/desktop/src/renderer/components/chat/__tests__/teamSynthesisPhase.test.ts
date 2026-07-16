import {
  captainSynthesisPreviewText,
  isTeamSynthesizing,
  teamSynthesisPhaseLabel,
  workerProgress,
} from "@/components/chat/teamSynthesisPhase";
import type { Execution, RunNode } from "@/stores/execution";
import { describe, expect, it } from "vitest";

function run(
  partial: Partial<RunNode> & Pick<RunNode, "id" | "status">,
): RunNode {
  return {
    agentId: partial.id,
    task: "t",
    dependsOn: [],
    parentRunId: null,
    kind: "agent",
    role: null,
    model: null,
    usage: null,
    cost: null,
    error: null,
    outputSummary: null,
    outputFiles: [],
    debrief: null,
    durationMs: null,
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
    ...partial,
    sideKey: partial.sideKey ?? null,
  };
}

function exec(partial: {
  status: Execution["status"];
  runs: RunNode[];
}): Execution {
  return {
    id: "e1",
    planType: "multi_agent",
    taskSummary: "并行调研",
    status: partial.status,
    agents: [],
    runs: partial.runs,
    progress: {
      completed: partial.runs.filter((r) => r.status === "completed").length,
      total: partial.runs.length,
    },
    batches: [],
    debate: null,
    debateRounds: [],
    crossExamEnabled: false,
    debateOpening: null,
    teamNotes: [],
  };
}

describe("teamSynthesisPhase", () => {
  it("workerProgress excludes captain", () => {
    const e = exec({
      status: "running",
      runs: [
        run({ id: "cap", status: "pending", kind: "captain" }),
        run({ id: "w1", status: "completed" }),
        run({ id: "w2", status: "completed" }),
      ],
    });
    expect(workerProgress(e)).toEqual({ completed: 2, total: 2 });
  });

  it("isTeamSynthesizing when all workers done and turn still running", () => {
    const e = exec({
      status: "running",
      runs: [
        run({ id: "w1", status: "completed" }),
        run({ id: "w2", status: "completed" }),
      ],
    });
    expect(isTeamSynthesizing(e)).toBe(true);
    expect(teamSynthesisPhaseLabel(e)).toBe("2/2 已完成，正在生成汇总");
  });

  it("not synthesizing while a worker is still running", () => {
    const e = exec({
      status: "running",
      runs: [
        run({ id: "w1", status: "completed" }),
        run({ id: "w2", status: "running" }),
      ],
    });
    expect(isTeamSynthesizing(e)).toBe(false);
  });

  it("not synthesizing after turn completes", () => {
    const e = exec({
      status: "completed",
      runs: [
        run({ id: "w1", status: "completed" }),
        run({ id: "w2", status: "completed" }),
      ],
    });
    expect(isTeamSynthesizing(e)).toBe(false);
  });

  it("captainSynthesisPreviewText prefers draft body over headline", () => {
    expect(
      captainSynthesisPreviewText({
        execution_id: "e",
        completed: 2,
        total: 2,
        headline: "合成草稿更新 · 已完成 2/2",
        text: "两边方向一致：优先方案 A。",
        workers: [],
        in_progress: true,
      }),
    ).toBe("两边方向一致：优先方案 A。");
  });
});
