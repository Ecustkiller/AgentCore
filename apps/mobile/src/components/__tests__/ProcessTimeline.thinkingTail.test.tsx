// @vitest-environment jsdom
import {
  ProcessTimeline,
  timelineTailHasLiveCue,
} from "@/components/ProcessTimeline";
import type { TeamPreviewTrace } from "@/protocol/teamPreviewTraces";
import type { ProcessStep } from "@agentcore/contract-types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

const doneSearch: ProcessStep = {
  kind: "tool",
  id: "t1",
  tool_name: "web_search",
  arguments: { query: "x" },
  result: null,
  status: "success",
};

const runningSearch: ProcessStep = {
  ...doneSearch,
  status: "running",
};

const waitDone: ProcessStep = {
  kind: "tool",
  id: "w1",
  tool_name: "wait",
  arguments: {},
  result: null,
  status: "success",
};

const teamMarker: ProcessStep = { kind: "team", execution_id: "e1" };

const graphAppendMarker: ProcessStep = {
  kind: "graph_append",
  execution_id: "e1",
  host_message_id: "m1",
  added_count: 2,
};

const adjustTrace = new Map<string, TeamPreviewTrace>([
  [
    "tp1",
    {
      status: "resolved",
      primitive: "delegate",
      decision: "adjust",
      note: "改成两人",
      headline: "",
      workerCount: 2,
      sideCount: 0,
      excludedCount: 0,
      tightenedCount: 0,
      label: "已调整 · 已交回修订 · 预计 2 人开工",
    },
  ],
]);

describe("timelineTailHasLiveCue", () => {
  it("空尾 / 已完成非 wait 工具 / 痕迹步都不是活节点", () => {
    expect(timelineTailHasLiveCue(undefined)).toBe(false);
    expect(timelineTailHasLiveCue(doneSearch)).toBe(false);
    expect(
      timelineTailHasLiveCue({ kind: "team_preview", checkpoint_id: "tp1" }),
    ).toBe(false);
    expect(timelineTailHasLiveCue(teamMarker)).toBe(false);
    expect(
      timelineTailHasLiveCue(teamMarker, { teamGraphVisible: false }),
    ).toBe(false);
    expect(
      timelineTailHasLiveCue(graphAppendMarker, { teamGraphVisible: false }),
    ).toBe(false);
  });

  it("跑着的工具、wait 空转、流式 Thought/正文/回炉、可见协作图是活节点", () => {
    expect(timelineTailHasLiveCue(runningSearch)).toBe(true);
    expect(timelineTailHasLiveCue(waitDone)).toBe(true);
    expect(timelineTailHasLiveCue({ kind: "reasoning", text: "想" })).toBe(
      true,
    );
    expect(timelineTailHasLiveCue({ kind: "content", text: "旁白" })).toBe(
      true,
    );
    expect(timelineTailHasLiveCue({ kind: "rework" })).toBe(true);
    expect(timelineTailHasLiveCue(teamMarker, { teamGraphVisible: true })).toBe(
      true,
    );
    expect(
      timelineTailHasLiveCue(graphAppendMarker, { teamGraphVisible: true }),
    ).toBe(true);
  });
});

describe("ProcessTimeline · thinking tail", () => {
  it("流式 + 尾部 team 标记且无协作图 → 思考中", () => {
    render(<ProcessTimeline steps={[teamMarker]} isStreaming />);
    expect(screen.getByTestId("thinking-tail")).toBeTruthy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("流式 + 尾部已交回修订痕迹 → 思考中（不写 adjust 特例文案）", () => {
    render(
      <ProcessTimeline
        steps={[{ kind: "team_preview", checkpoint_id: "tp1" }, teamMarker]}
        teamPreviewTraces={adjustTrace}
        isStreaming
      />,
    );
    expect(screen.getByTestId("team-preview-trace")).toBeTruthy();
    expect(screen.getByTestId("thinking-tail")).toBeTruthy();
    expect(screen.queryByText("CEO 正在按你的意见重排团队")).toBeNull();
  });

  it("流式 + 已完成非 wait 工具 → 思考中（原行为）", () => {
    render(<ProcessTimeline steps={[doneSearch]} isStreaming />);
    expect(screen.getByTestId("thinking-tail")).toBeTruthy();
  });

  it("流式 + 跑着的工具 / wait 空转 / 非流式 → 不刷尾迹", () => {
    const { rerender } = render(
      <ProcessTimeline steps={[runningSearch]} isStreaming />,
    );
    expect(screen.queryByTestId("thinking-tail")).toBeNull();
    rerender(<ProcessTimeline steps={[waitDone]} isStreaming />);
    expect(screen.queryByTestId("thinking-tail")).toBeNull();
    rerender(<ProcessTimeline steps={[teamMarker]} />);
    expect(screen.queryByTestId("thinking-tail")).toBeNull();
  });
});
