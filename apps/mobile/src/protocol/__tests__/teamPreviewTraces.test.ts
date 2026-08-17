import { describe, expect, it } from "vitest";
import {
  extractTeamPreviewTraces,
  teamPreviewResolvedLabel,
} from "../teamPreviewTraces";

describe("teamPreviewResolvedLabel", () => {
  it("adjust 用已交回修订 + 预计人数", () => {
    expect(
      teamPreviewResolvedLabel({
        primitive: "delegate",
        decision: "adjust",
        hasNote: true,
        workerCount: 2,
        sideCount: 0,
      }),
    ).toBe("已调整 · 已交回修订 · 预计 2 人开工");
  });

  it("debate adjust 用预计方数", () => {
    expect(
      teamPreviewResolvedLabel({
        primitive: "debate",
        decision: "adjust",
        hasNote: true,
        workerCount: 0,
        sideCount: 2,
      }),
    ).toBe("已调整 · 已交回修订 · 预计 2 方开赛");
  });
});

describe("extractTeamPreviewTraces", () => {
  it("pending 不给结论文；resolved adjust 带意见原文", () => {
    const traces = extractTeamPreviewTraces([
      {
        type: "team_preview_required",
        payload: {
          checkpoint_id: "tp1",
          primitive: "delegate",
          headline: "",
          workers: [{ run_id: "r1" }, { run_id: "r2" }],
          sides: [],
        },
      },
      {
        type: "team_preview_resolved",
        payload: {
          checkpoint_id: "tp1",
          decision: "adjust",
          note: "改成两人，先做竞品",
        },
      },
    ]);
    const t = traces.get("tp1");
    expect(t?.status).toBe("resolved");
    expect(t?.decision).toBe("adjust");
    expect(t?.note).toBe("改成两人，先做竞品");
    expect(t?.label).toBe("已调整 · 已交回修订 · 预计 2 人开工");
  });

  it("required-only stays pending with empty label", () => {
    const traces = extractTeamPreviewTraces([
      {
        type: "team_preview_required",
        payload: {
          checkpoint_id: "tp-pending",
          primitive: "delegate",
          workers: [{ run_id: "r1" }],
        },
      },
    ]);
    expect(traces.get("tp-pending")?.status).toBe("pending");
    expect(traces.get("tp-pending")?.label).toBe("");
  });
});
