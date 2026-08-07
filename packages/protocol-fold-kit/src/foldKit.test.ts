import { describe, expect, it } from "vitest";
import {
  FINISH_TO_STATUS,
  MARKER_STANDIN_TOOLS,
  ORCHESTRATION_TOOLS,
  isMarkerStandinTool,
  isOrchestrationTool,
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
