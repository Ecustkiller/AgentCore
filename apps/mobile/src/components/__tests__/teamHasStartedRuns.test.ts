import {
  isKickoffGoDecision,
  kickoffReleasedFromCold,
  shouldShowTeamGraph,
  teamHasStartedRuns,
} from "@/components/ProcessTimeline";
import { describe, expect, it } from "vitest";

describe("teamHasStartedRuns · TeamView graph gate", () => {
  it("开工挂起（全 pending）不出图", () => {
    expect(
      teamHasStartedRuns([{ status: "pending" }, { status: "pending" }]),
    ).toBe(false);
  });

  it("开工即停止（全 skipped）不出图", () => {
    expect(
      teamHasStartedRuns([{ status: "skipped" }, { status: "skipped" }]),
    ).toBe(false);
  });

  it("pending + skipped 混排仍不出图", () => {
    expect(
      teamHasStartedRuns([{ status: "pending" }, { status: "skipped" }]),
    ).toBe(false);
  });

  it("plan_review 波间挂起（已有完成节点）仍出图", () => {
    expect(
      teamHasStartedRuns([{ status: "completed" }, { status: "pending" }]),
    ).toBe(true);
  });

  it("授权后续跑（running）出图", () => {
    expect(
      teamHasStartedRuns([{ status: "running" }, { status: "pending" }]),
    ).toBe(true);
  });

  it("空 runs 不出图", () => {
    expect(teamHasStartedRuns([])).toBe(false);
  });

  it("captain running 不算工人已开工", () => {
    expect(
      teamHasStartedRuns([
        { status: "running", kind: "captain" },
        { status: "pending" },
      ]),
    ).toBe(false);
  });
});

describe("shouldShowTeamGraph", () => {
  const pending = [{ status: "pending" }, { status: "pending" }];

  it("未授权 + pending 不出图", () => {
    expect(shouldShowTeamGraph(pending, false)).toBe(false);
  });

  it("已授权 + pending 编制立刻出图", () => {
    expect(shouldShowTeamGraph(pending, true)).toBe(true);
  });

  it("已授权但零 run 仍不出图", () => {
    expect(shouldShowTeamGraph([], true)).toBe(false);
  });

  it("captain 已开 + 工人 pending + 未授权 → 不出图", () => {
    expect(
      shouldShowTeamGraph(
        [
          { status: "running", kind: "captain" },
          { status: "pending" },
          { status: "pending" },
        ],
        false,
      ),
    ).toBe(false);
  });
});

describe("kickoffReleasedFromCold", () => {
  it("本消息 team_preview continue → released", () => {
    expect(
      kickoffReleasedFromCold(
        [
          {
            kind: "team_preview",
            messageId: "m1",
            status: "resolved",
            resolution: { decision: "continue" },
          },
        ],
        "m1",
      ),
    ).toBe(true);
  });

  it("submitting continue 也算已放行", () => {
    expect(
      kickoffReleasedFromCold(
        [
          {
            kind: "team_preview",
            messageId: "m1",
            status: "submitting",
            resolution: { decision: "continue" },
          },
        ],
        "m1",
      ),
    ).toBe(true);
  });

  it("stop / 其它消息 / pending 都不放行", () => {
    expect(
      kickoffReleasedFromCold(
        [
          {
            kind: "team_preview",
            messageId: "m1",
            status: "resolved",
            resolution: { decision: "stop" },
          },
        ],
        "m1",
      ),
    ).toBe(false);
    expect(
      kickoffReleasedFromCold(
        [
          {
            kind: "team_preview",
            messageId: "other",
            status: "resolved",
            resolution: { decision: "continue" },
          },
        ],
        "m1",
      ),
    ).toBe(false);
    expect(
      kickoffReleasedFromCold(
        [
          {
            kind: "team_preview",
            messageId: "m1",
            status: "pending",
            resolution: { decision: "continue" },
          },
        ],
        "m1",
      ),
    ).toBe(false);
  });

  it("team_preview adjust 不开工（回灌 CEO）", () => {
    expect(isKickoffGoDecision("adjust")).toBe(false);
    expect(isKickoffGoDecision("continue")).toBe(true);
    expect(
      kickoffReleasedFromCold(
        [
          {
            kind: "team_preview",
            messageId: "m1",
            status: "resolved",
            resolution: { decision: "adjust" },
          },
        ],
        "m1",
      ),
    ).toBe(false);
  });

  it("同消息上一轮已开做 + 本轮仍 pending → 不放行", () => {
    expect(
      kickoffReleasedFromCold(
        [
          {
            kind: "team_preview",
            messageId: "m1",
            status: "resolved",
            resolution: { decision: "continue" },
          },
          {
            kind: "team_preview",
            messageId: "m1",
            status: "pending",
          },
        ],
        "m1",
      ),
    ).toBe(false);
  });
});
