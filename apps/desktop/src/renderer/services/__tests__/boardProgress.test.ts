import {
  type OverlayAnchor,
  buildProgressOverlay,
} from "@/services/boardProgress";
import type {
  AgentState,
  Execution,
  RunNode,
  RunStatus,
} from "@/stores/execution";
import { describe, expect, it } from "vitest";

const agent = (id: string, role: string): AgentState => ({
  id,
  role,
  modelPreference: "strong",
  thinking: true,
  reasoningEffort: "high",
  status: "idle",
  currentRunId: null,
  outputChunks: [],
  reasoningChunks: [],
  toolCalls: [],
  toolProgress: null,
  toolExecutionLive: null,
});

const run = (id: string, agentId: string, status: RunStatus): RunNode => ({
  id,
  agentId,
  task: `task ${id}`,
  status,
  dependsOn: [],
  outputSummary: null,
  outputFiles: [],
  debrief: null,
  durationMs: null,
  error: null,
  parentRunId: null,
  kind: "agent",
  role: null,
  model: null,
  usage: null,
  cost: null,
  stance: null,
  group: null,
  round: 0,
  revisionOf: null,
  revision: 0,
  revised: null,
  replacesRunId: null,
  checkpoint: null,
  receivedContext: [],
  escalations: [],
});

const execution = (over: Partial<Execution>): Execution => ({
  id: "exec1",
  planType: "multi_agent",
  taskSummary: "做点东西",
  status: "running",
  agents: [],
  runs: [],
  progress: { completed: 0, total: 0 },
  batches: [],
  debate: null,
  debateRounds: [],
  debateDecisions: [],
  teamNotes: [],
  ...over,
});

const anchor: OverlayAnchor = { x: 100, y: 50, width: 200, height: 120 };

describe("buildProgressOverlay", () => {
  it("returns [] when the team has no runs (nothing to show)", () => {
    expect(buildProgressOverlay(execution({ runs: [] }), anchor)).toEqual([]);
  });

  it("emits a header card, a connector arrow, and one card per run", () => {
    const out = buildProgressOverlay(
      execution({
        agents: [agent("ag1", "架构师"), agent("ag2", "工程师")],
        runs: [run("r1", "ag1", "running"), run("r2", "ag2", "pending")],
      }),
      anchor,
    );
    const header = out.find((e) => e.id === "ovl-header");
    const link = out.find((e) => e.id === "ovl-link");
    const cards = out.filter((e) => e.id.startsWith("ovl-run-"));
    expect(header?.type).toBe("agentNode");
    expect(link?.type).toBe("arrow");
    expect(cards).toHaveLength(2);
  });

  it("maps run status → visual status and labels the role from the agent map", () => {
    const out = buildProgressOverlay(
      execution({
        agents: [agent("ag1", "架构师")],
        runs: [run("r1", "ag1", "completed")],
      }),
      anchor,
    );
    const card = out.find((e) => e.id === "ovl-run-r1");
    expect(card?.runStatus).toBe("completed");
    expect(card?.text).toContain("架构师");
    expect(card?.text).toContain("已完成");
  });

  it("maps skipped to muted cancelled tone with 未执行 label", () => {
    const out = buildProgressOverlay(
      execution({
        agents: [agent("ag1", "工程师")],
        runs: [run("r1", "ag1", "skipped")],
      }),
      anchor,
    );
    const card = out.find((e) => e.id === "ovl-run-r1");
    expect(card?.runStatus).toBe("cancelled");
    expect(card?.text).toContain("未执行");
  });

  it("drives the header status from the execution status", () => {
    const out = buildProgressOverlay(
      execution({
        status: "failed",
        agents: [agent("ag1", "工程师")],
        runs: [run("r1", "ag1", "failed")],
      }),
      anchor,
    );
    const header = out.find((e) => e.id === "ovl-header");
    expect(header?.runStatus).toBe("failed");
    expect(header?.text).toContain("失败");
  });

  it("docks every card to the right of the brief and points the arrow back at it", () => {
    const out = buildProgressOverlay(
      execution({
        agents: [agent("ag1", "工程师")],
        runs: [run("r1", "ag1", "running")],
      }),
      anchor,
    );
    const rightEdge = anchor.x + anchor.width;
    for (const card of out.filter((e) => e.type === "agentNode")) {
      expect(card.x).toBeGreaterThan(rightEdge);
    }
    const link = out.find((e) => e.id === "ovl-link");
    // arrow tip (last point) lands on the brief's right edge → reads as "贴源".
    expect(link?.points?.at(-1)?.[0]).toBe(rightEdge);
  });

  it("falls back to task then agentId when no agent role is known", () => {
    const out = buildProgressOverlay(
      execution({ agents: [], runs: [run("r1", "ghost", "running")] }),
      anchor,
    );
    // run.task is "task r1" (our helper) → used as the label fallback
    expect(out.find((e) => e.id === "ovl-run-r1")?.text).toContain("task r1");
  });
});
