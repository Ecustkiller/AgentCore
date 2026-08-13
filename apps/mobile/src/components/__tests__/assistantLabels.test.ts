/**
 * 工具行标题参数：内部标识不进用户面。
 *
 * 回归钉：`toolDetail` 挑不到常规参数时会回落到「第一个字符串参数」，于是撤队员 / 裁决求助
 * （参数只有 run_id）的标题就成了 `撤回队员 r-a3f2e1c8-…`——用户对不上协作图上的角色名。
 */
import { toolDetail } from "@/components/assistantLabels";
import { describe, expect, it } from "vitest";

describe("toolDetail · 标题参数", () => {
  it("常规定位参数照常上标题", () => {
    expect(toolDetail({ query: "竞品定价" })).toBe("竞品定价");
    expect(toolDetail({ path: "docs/方案.md" })).toBe("docs/方案.md");
  });

  it("`id` / `*_id` 一律不进标题（回落也不捡）", () => {
    expect(toolDetail({ run_id: "r-a3f2e1c8-9b21" })).toBe("");
    expect(toolDetail({ conversation_id: "c-8f31ab02" })).toBe("");
    expect(toolDetail({ interjection_id: "i-77120c9a" })).toBe("");
    expect(toolDetail({ id: "x-1" })).toBe("");
  });

  it("同时有 id 与可读参数时，取可读的那个", () => {
    expect(toolDetail({ run_id: "r-a3f2e1c8-9b21", reason: "方向跑偏" })).toBe(
      "方向跑偏",
    );
  });
});
