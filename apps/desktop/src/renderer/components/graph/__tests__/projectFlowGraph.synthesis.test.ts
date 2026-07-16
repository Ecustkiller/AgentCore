import type { Execution } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import { INPUT_ID } from "../constants";
import { projectFlowNodes } from "../projectFlowGraph";

function minimalExec(): Execution {
  return {
    id: "e1",
    planType: "multi_agent",
    taskSummary: "并行调研",
    status: "running",
    agents: [],
    runs: [
      {
        id: "captain",
        agentId: "ceo",
        task: "",
        status: "pending",
        dependsOn: [],
        outputSummary: null,
        outputFiles: [],
        debrief: null,
        durationMs: null,
        error: null,
        parentRunId: null,
        kind: "captain",
        role: null,
        model: null,
        usage: null,
        cost: null,
        stance: null,
        group: null,
        round: 0,
        sideKey: null,
        continuesRunId: null,
        continuationIndex: 0,
        replacesRunId: null,
        revised: null,
        checkpoint: null,
        receivedContext: [],
        escalations: [],
        process: [],
      },
      {
        id: "w1",
        agentId: "w1",
        task: "调研",
        status: "completed",
        dependsOn: [],
        outputSummary: "ok",
        outputFiles: [],
        debrief: null,
        durationMs: 100,
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
        replacesRunId: null,
        revised: null,
        checkpoint: null,
        receivedContext: [],
        escalations: [],
        process: [],
      },
    ],
    progress: { completed: 1, total: 2 },
    batches: [],
    debate: null,
    debateRounds: [],
    crossExamEnabled: false,
    debateOpening: null,
    teamNotes: [],
  };
}

describe("projectFlowNodes · captain synthesis preview", () => {
  it("挂 team_synthesis_preview 片段到 running CEO 节点（无终稿时）", () => {
    const execution = minimalExec();
    const nodes = projectFlowNodes({
      execution,
      positions: {
        [INPUT_ID]: { x: 0, y: 0 },
        captain: { x: 0, y: 200 },
        w1: { x: 0, y: 100 },
      },
      nodeHeights: {},
      nodeSizes: {},
      handleDirection: "vertical",
      cnyPerUsd: 7,
      litRunId: null,
      litEndpointMessageId: null,
      captainRun: { id: "captain" },
      captainStatus: "running",
      finalAnswer: null,
      captainSynthesisPreview: "两边方向一致：优先方案 A。",
      taskMessage: null,
      activateNode: () => {},
      groups: [],
      subTeams: [],
    });

    const captain = nodes.find((n) => n.id === "captain");
    expect(captain?.data).toMatchObject({
      variant: "captain",
      status: "running",
      preview: "两边方向一致：优先方案 A。",
    });
  });

  it("终稿优先于 synthesis preview", () => {
    const execution = minimalExec();
    const nodes = projectFlowNodes({
      execution,
      positions: {
        [INPUT_ID]: { x: 0, y: 0 },
        captain: { x: 0, y: 200 },
        w1: { x: 0, y: 100 },
      },
      nodeHeights: {},
      nodeSizes: {},
      handleDirection: "vertical",
      cnyPerUsd: 7,
      litRunId: null,
      litEndpointMessageId: null,
      captainRun: { id: "captain" },
      captainStatus: "running",
      finalAnswer: { id: "ans", content: "最终方案全文在此。" },
      captainSynthesisPreview: "草稿不应出现",
      taskMessage: null,
      activateNode: () => {},
      groups: [],
      subTeams: [],
    });

    const captain = nodes.find((n) => n.id === "captain");
    expect(captain?.data.preview).toContain("最终方案");
    expect(String(captain?.data.preview)).not.toContain("草稿不应出现");
  });
});
