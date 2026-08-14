// @vitest-environment jsdom
/**
 * 完成态团队条：子任务 n/m、用时、花费。并行省时已从产品删掉——条上不得回潮。
 */
import { TeamView } from "@/components/TeamView";
import type {
  ProjectedAgent,
  ProjectedRun,
} from "@agentcore/protocol-conformance";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function makeAgent(
  p: Partial<ProjectedAgent> & { id: string; role: string },
): ProjectedAgent {
  return {
    thinking: false,
    status: "completed",
    currentRunId: null,
    output: "",
    reasoning: "",
    toolProgress: null,
    ...p,
  };
}

function makeRun(p: Partial<ProjectedRun> & { id: string }): ProjectedRun {
  return {
    agentId: "a1",
    task: "task",
    status: "completed",
    dependsOn: [],
    outputSummary: null,
    debrief: null,
    durationMs: null,
    error: null,
    failureKind: null,
    productLanded: null,
    parentRunId: null,
    kind: "agent",
    role: "队员",
    model: null,
    usage: null,
    cost: null,
    stance: null,
    group: null,
    round: 0,
    continuesRunId: null,
    revised: null,
    replacesRunId: null,
    checkpoint: null,
    receivedContext: [],
    escalations: [],
    process: [],
    actId: "act-1",
    ...p,
  };
}

const AGENTS = [
  makeAgent({ id: "a1", role: "调研员" }),
  makeAgent({ id: "a2", role: "分析师" }),
  makeAgent({ id: "a3", role: "审校" }),
];

/** 三人同时开工：各 ~40s（合计 2m1s），用户只等了 42s。 */
const PARALLEL_RUNS = [
  makeRun({ id: "r1", agentId: "a1", role: "调研员", durationMs: 39_000 }),
  makeRun({ id: "r2", agentId: "a2", role: "分析师", durationMs: 40_000 }),
  makeRun({ id: "r3", agentId: "a3", role: "审校", durationMs: 42_000 }),
];

const PROGRESS = { completed: 3, total: 3 };

function meta(): string {
  return document.querySelector(".team-strip-meta")?.textContent ?? "";
}

function metaTitle(): string {
  return (
    document.querySelector(".team-strip-meta")?.getAttribute("title") ?? ""
  );
}

function assertNoSavingCopy() {
  const surface = `${meta()}${metaTitle()}`;
  expect(surface).not.toContain("同时开工省下");
  expect(surface).not.toContain("省下");
}

describe("TeamView 团队条 · 并行省时不得回潮", () => {
  it("完成态并行回合：条上有子任务与墙钟用时，不得出现「同时开工省下」/「省下」", () => {
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
      />,
    );
    expect(meta()).toContain("3/3 子任务");
    expect(meta()).toContain("用时 42s");
    assertNoSavingCopy();
  });

  it("title tooltip 也不再写省时", () => {
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
      />,
    );
    expect(metaTitle()).toBe("");
    assertNoSavingCopy();
  });

  it("进行中 / 失败 / 已停止同样不得出现「省下」", () => {
    for (const status of ["running", "failed", "cancelled"] as const) {
      render(
        <TeamView
          agents={AGENTS}
          runs={PARALLEL_RUNS}
          progress={PROGRESS}
          status={status}
          elapsedMs={42_000}
        />,
      );
      assertNoSavingCopy();
      cleanup();
    }
  });
});
