import { describe, expect, it } from "vitest";
import {
  FINISH_TO_STATUS,
  MARKER_STANDIN_TOOLS,
  ORCHESTRATION_TOOLS,
  isMarkerStandinTool,
  isOrchestrationTool,
  isRunFrameEvent,
  turnElapsedMs,
  turnStatusFromFinish,
} from "./index";

describe("ORCHESTRATION_TOOLS / MARKER_STANDIN_TOOLS", () => {
  it("pins delegate + debate as orchestration", () => {
    expect([...ORCHESTRATION_TOOLS].sort()).toEqual(["debate", "delegate"]);
    expect(isOrchestrationTool("delegate")).toBe(true);
    expect(isOrchestrationTool("debate")).toBe(true);
    expect(isOrchestrationTool("ask_user")).toBe(false);
    expect(isOrchestrationTool("file_read")).toBe(false);
  });

  it("pins ask_user as marker stand-in alongside orchestration", () => {
    expect([...MARKER_STANDIN_TOOLS].sort()).toEqual([
      "ask_user",
      "debate",
      "delegate",
    ]);
    expect(isMarkerStandinTool("ask_user")).toBe(true);
    expect(isMarkerStandinTool("delegate")).toBe(true);
    expect(isMarkerStandinTool("web_search")).toBe(false);
  });
});

describe("turnStatusFromFinish", () => {
  it("maps known finish_reason values", () => {
    expect(turnStatusFromFinish("end_turn")).toBe("completed");
    expect(turnStatusFromFinish("error")).toBe("failed");
    expect(turnStatusFromFinish("cancelled")).toBe("cancelled");
    expect(turnStatusFromFinish("interrupted")).toBe("cancelled");
    expect(turnStatusFromFinish("paused")).toBe("paused");
    expect(turnStatusFromFinish("unknown_reason")).toBe("completed");
  });

  it("exposes the same table used by folds", () => {
    expect(FINISH_TO_STATUS.paused).toBe("paused");
    expect(FINISH_TO_STATUS.unproductive).toBe("completed");
  });
});

describe("turnElapsedMs (回合用时)", () => {
  const at = (sec: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();

  it("是首末协作事件的墙钟跨度，不随并行队员数膨胀", () => {
    // 三名队员各跑 ~40s，但同时开跑：用户等的是 42s，不是工时合计 2m。
    const events = [
      { type: "run_started", timestamp: at(2) },
      { type: "run_started", timestamp: at(2) },
      { type: "run_started", timestamp: at(2) },
      { type: "run_completed", timestamp: at(41) },
      { type: "run_completed", timestamp: at(42) },
      { type: "run_completed", timestamp: at(44) },
    ];
    expect(turnElapsedMs(events)).toBe(42_000);
  });

  it("只认协作事件——正文流不撑长跨度", () => {
    expect(isRunFrameEvent("content_delta")).toBe(false);
    expect(isRunFrameEvent("run_completed")).toBe(true);
    const events = [
      { type: "content_delta", timestamp: at(0) },
      { type: "run_started", timestamp: at(10) },
      { type: "run_completed", timestamp: at(20) },
      { type: "content_delta", timestamp: at(90) },
    ];
    expect(turnElapsedMs(events)).toBe(10_000);
  });

  it("不足两条可用协作事件时为 0（无跨度可言，调用方不显示用时）", () => {
    expect(turnElapsedMs([])).toBe(0);
    expect(turnElapsedMs([{ type: "run_started", timestamp: at(3) }])).toBe(0);
    expect(turnElapsedMs([{ type: "content_delta", timestamp: at(3) }])).toBe(
      0,
    );
  });

  it("时戳缺失 / 不可解析的事件跳过，不拿本机时钟顶替", () => {
    const events = [
      { type: "run_started", timestamp: null },
      { type: "run_started", timestamp: "not-a-date" },
      { type: "run_started", timestamp: at(5) },
      { type: "run_completed", timestamp: at(9) },
    ];
    expect(turnElapsedMs(events)).toBe(4_000);
  });
});
