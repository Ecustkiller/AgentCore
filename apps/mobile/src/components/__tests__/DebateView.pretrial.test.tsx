// @vitest-environment jsdom
/**
 * 手机辩论 UI 已去掉「庭前准备」行/块；无 rounds 不占位。
 */

import { DebateView, LiveDebateNarrative } from "@/components/DebateView";
import type {
  DebateNarrativeRound,
  DebateResultPayload,
} from "@agentcore/contract-types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function minimalDebate(): DebateResultPayload {
  return {
    execution_id: "exec-1",
    moderator_run_id: "moderator",
    form: "debate",
    motion: "是否采用方案 A",
    stop_reason: "converged",
    narrative_first: false,
    sides: [
      {
        key: "pro",
        name: "正方",
        stance: "pro",
        model: undefined,
        is_subject: false,
      },
      {
        key: "con",
        name: "反方",
        stance: "con",
        model: undefined,
        is_subject: false,
      },
    ],
    rounds: [],
    brief: {
      leaning: "倾向正方",
      confidence: "high",
      decisive: "证据更扎实",
      crux: "成本可否接受",
      recommendation: "先做试点",
      strongest_points: { pro: "ROI 清晰", con: "风险未清" },
      handoffs: [],
    },
  } as DebateResultPayload;
}

function oneLiveRound(): DebateNarrativeRound {
  return {
    round_no: 1,
    focus: "成本",
    summary: "小结",
    verdict: null,
    sides: [],
    clashes: [],
    cross_exam: [],
  };
}

describe("DebateView 无庭前准备 UI", () => {
  it("收场视图不渲染「庭前准备」", () => {
    render(<DebateView debate={minimalDebate()} />);
    expect(screen.queryByText("庭前准备")).toBeNull();
    expect(screen.getByText("主持人终审")).toBeTruthy();
  });

  it("有 rounds 时标题为「辩论进行中」，无「庭前准备」", () => {
    render(<LiveDebateNarrative rounds={[oneLiveRound()]} />);
    expect(screen.getByText("辩论进行中")).toBeTruthy();
    expect(screen.queryByText("庭前准备")).toBeNull();
  });

  it("无 rounds 时不渲染占位（不写死「庭前准备」）", () => {
    const { container } = render(<LiveDebateNarrative rounds={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("庭前准备")).toBeNull();
  });
});
