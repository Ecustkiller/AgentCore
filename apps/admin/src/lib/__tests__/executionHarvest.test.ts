import {
  EXECUTION_HARVEST_ORIGIN,
  harvestKindLabel,
  isExecutionHarvestMessage,
} from "@/lib/executionHarvest";
import { describe, expect, it } from "vitest";

describe("executionHarvest helpers", () => {
  it("detects origin and 【系统收口】 prefix", () => {
    expect(
      isExecutionHarvestMessage({
        role: "user",
        origin: EXECUTION_HARVEST_ORIGIN,
        content: "hi",
      }),
    ).toBe(true);
    expect(
      isExecutionHarvestMessage({
        role: "user",
        content: "【系统收口】后台团队任务已全部完成。",
      }),
    ).toBe(true);
    expect(
      isExecutionHarvestMessage({ role: "user", content: "普通提问" }),
    ).toBe(false);
    expect(
      isExecutionHarvestMessage({
        role: "assistant",
        origin: EXECUTION_HARVEST_ORIGIN,
        content: "x",
      }),
    ).toBe(false);
  });

  it("maps harvest_kind and content heuristics", () => {
    expect(harvestKindLabel("cancelled")).toBe("已取消");
    expect(harvestKindLabel("failure")).toBe("有失败");
    expect(harvestKindLabel("success")).toBe("已完成");
    expect(
      harvestKindLabel(null, "【系统收口】后台团队任务已取消或中断。"),
    ).toBe("已取消");
    expect(harvestKindLabel(null, "普通")).toBeNull();
  });
});
