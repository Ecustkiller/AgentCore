import { teamHasStartedRuns } from "@/components/ProcessTimeline";
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
});
