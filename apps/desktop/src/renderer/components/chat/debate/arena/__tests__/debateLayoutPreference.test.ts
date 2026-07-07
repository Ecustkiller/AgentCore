// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { DebateModel, DebateSideModel } from "../../model";
import {
  canUseSplitLayout,
  loadDebateArenaLayout,
  partitionProCon,
  saveDebateArenaLayout,
} from "../debateLayoutPreference";

describe("debateLayoutPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to split and persists stack", () => {
    expect(loadDebateArenaLayout()).toBe("split");
    saveDebateArenaLayout("stack");
    expect(loadDebateArenaLayout()).toBe("stack");
  });

  it("canUseSplitLayout requires debate form with pro/con", () => {
    const base: DebateModel = {
      form: "debate",
      motion: null,
      stopReason: null,
      moderatorRunId: null,
      narrativeFirst: false,
      rounds: [],
      brief: null,
      sides: [
        {
          key: "pro",
          name: "正方",
          stance: "支持采用方案 A",
          model: "",
          is_subject: false,
        },
        {
          key: "con",
          name: "反方",
          stance: "反对采用方案 A",
          model: "",
          is_subject: false,
        },
      ],
      closings: [],
      opening: null,
      settled: false,
    };
    expect(canUseSplitLayout(base)).toBe(true);

    expect(canUseSplitLayout({ ...base, form: "red_team" })).toBe(false);
    expect(
      canUseSplitLayout({
        ...base,
        sides: null,
        rounds: [
          {
            roundNo: 1,
            focus: "",
            summary: "",
            verdict: null,
            inFlight: true,
            clashes: [],
            userInterjections: [],
            crossExam: [],
            scores: [],
            sides: [
              {
                key: "r1",
                sideKey: "pro",
                name: "正方",
                stance: "pro",
                colorVar: "var(--debate-side-pro)",
                model: "",
                run: null,
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("partitionProCon maps by stance or sideKey", () => {
    const pro = {
      key: "1",
      sideKey: "pro",
      name: "正",
      stance: null,
    } as DebateSideModel;
    const con = {
      key: "2",
      sideKey: "con",
      name: "反",
      stance: null,
    } as DebateSideModel;
    expect(partitionProCon([con, pro])).toEqual({ pro, con });
  });
});
