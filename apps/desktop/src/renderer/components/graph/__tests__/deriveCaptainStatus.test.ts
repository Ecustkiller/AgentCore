import type { Execution, RunNode } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import { deriveCaptainStatus } from "../helpers";

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
    acts: [],
    batches: [],
    debate: null,
    debateRounds: [],
    crossExamEnabled: false,
    debateOpening: null,
    debatePretrial: null,
    teamNotes: [],
  };
}

describe("deriveCaptainStatus", () => {
  it("returns running when workers are done and execution still running", () => {
    const e = exec({
      status: "running",
      runs: [
        run({ id: "cap", status: "pending", kind: "captain" }),
        run({ id: "w1", status: "completed" }),
        run({ id: "w2", status: "completed" }),
      ],
    });
    expect(deriveCaptainStatus(e, "cap")).toBe("running");
  });

  it("returns pending when execution is paused even if all workers done", () => {
    const e = exec({
      status: "paused",
      runs: [
        run({ id: "cap", status: "pending", kind: "captain" }),
        run({ id: "w1", status: "completed" }),
        run({ id: "w2", status: "completed" }),
      ],
    });
    // Clears「正在生成汇总」sink; RunStatus has no paused.
    expect(deriveCaptainStatus(e, "cap")).toBe("pending");
  });

  it("ignores extra append-turn captains when judging worker completion", () => {
    const e = exec({
      status: "running",
      runs: [
        run({ id: "cap", status: "pending", kind: "captain" }),
        run({ id: "w1", status: "completed" }),
        // Leaked append captain still pending — must not block sink「汇总中」.
        run({ id: "cap2", status: "pending", kind: "captain" }),
      ],
    });
    expect(deriveCaptainStatus(e, "cap")).toBe("running");
  });
});
