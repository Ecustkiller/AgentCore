// @vitest-environment jsdom
/**
 * 完成态团队条：找一支团队换来了什么，得看得见。
 *
 * 两条都只是**已有数据换个说法**（零新增评价）：
 *   1. 并行省时 —— 用时（墙钟跨度）旁边给出各队员时长之和的对比；
 *   2. 互相把关 —— 原「纠偏 / 漂移 / 唤回 / 上报」四个负面内部计数的收益口径。
 * 两句都与桌面共用 `@agentcore/protocol-fold-kit`：同一句、同一个数（「用时」曾两端各写
 * 一份，结果分叉成 40s / 2m10s）。无可说时保持沉默。
 */
import { TeamView } from "@/components/TeamView";
import { formatDuration } from "@/lib/time";
import type {
  ProjectedAgent,
  ProjectedRun,
} from "@agentcore/protocol-conformance";
import {
  parallelSaving,
  parallelSavingText,
} from "@agentcore/protocol-fold-kit";
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

function collabLine(): string | null {
  return document.querySelector(".team-strip-collab")?.textContent ?? null;
}

describe("TeamView 团队条 · 并行省了多少时间", () => {
  it("完成态在「用时」旁给出对比：串行 2m1s − 用时 42s", () => {
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
      />,
    );
    expect(meta()).toContain("用时 42s");
    expect(meta()).toContain("同时开工省下 1m19s");
  });

  it("说的是共享口径那一句——不是团队条自己拼的（桌面同串同数）", () => {
    // 同一组数在 apps/desktop StatusStrip.parallelSaving.test.tsx 断言同一句。
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
      />,
    );
    const gain = parallelSaving({ elapsedMs: 42_000, runs: PARALLEL_RUNS });
    // 这组数算不出省时，就不是「文案对不对」的问题了——先炸在这里，别拿 null 去比串。
    if (!gain) throw new Error("parallelSaving 对这组并行数据没给出省时");
    const shared = parallelSavingText(gain, formatDuration);
    expect(shared).toBe("同时开工省下 1m19s");
    expect(meta()).toContain(shared);
  });

  it("基准写在 tooltip 里，且不宣称「比单个 AI 快」", () => {
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
      />,
    );
    const tip =
      document.querySelector(".team-strip-meta")?.getAttribute("title") ?? "";
    expect(tip).toContain("一个接一个");
    expect(tip).toContain("不是拿一个 AI 做同一件事来比");
    expect(`${meta()}${tip}`).not.toMatch(/单\s*个?\s*AI\s*快|倍/);
  });

  it("只派了一个人 → 沉默", () => {
    render(
      <TeamView
        agents={[AGENTS[0]]}
        runs={[
          makeRun({
            id: "r1",
            agentId: "a1",
            role: "调研员",
            durationMs: 90_000,
          }),
        ]}
        progress={{ completed: 1, total: 1 }}
        status="completed"
        elapsedMs={92_000}
      />,
    );
    expect(meta()).not.toContain("省下");
  });

  it("接力跑（并行没省到）→ 沉默", () => {
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={121_000}
      />,
    );
    expect(meta()).not.toContain("省下");
  });

  it("进行中 / 失败 / 已停止都不说「省下」", () => {
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
      expect(meta()).not.toContain("省下");
      cleanup();
    }
  });
});

describe("TeamView 团队条 · 队友互相挑出了几处", () => {
  it("读起来是收益，不是四个负面内部计数", () => {
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
        collab={{
          boundary_yields: 0,
          scope_signals: 1,
          revises: 2,
          escalations: 1,
        }}
      />,
    );
    expect(collabLine()).toBe("互相把关：发现跑偏 1 处 · 返工重写 2 处");
    expect(collabLine()).not.toMatch(/纠偏|漂移|唤回|上报/);
  });

  it("全为 0 / 缺省 → 整行不渲染", () => {
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
        collab={{
          boundary_yields: 0,
          scope_signals: 0,
          revises: 0,
          escalations: 0,
        }}
      />,
    );
    expect(collabLine()).toBeNull();
    cleanup();
    render(
      <TeamView
        agents={AGENTS}
        runs={PARALLEL_RUNS}
        progress={PROGRESS}
        status="completed"
        elapsedMs={42_000}
      />,
    );
    expect(collabLine()).toBeNull();
  });
});
