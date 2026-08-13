/**
 * 桌面出口钉：`@/lib/collabSummary` 转出的是共享 kit 的收益口径（手机说同一句、同一个数）。
 * 分档细则在 packages/protocol-fold-kit/src/teamGain.test.ts；这里只守桌面这一侧不回流旧口径。
 */
import {
  COLLAB_SUMMARY_TOOLTIP,
  formatCollabSummary,
} from "@/lib/collabSummary";
import { describe, expect, it } from "vitest";

describe("formatCollabSummary", () => {
  it("无可说则沉默（缺省 / 全 0）", () => {
    expect(formatCollabSummary(undefined)).toBeNull();
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 0,
        escalations: 0,
      }),
    ).toBeNull();
  });

  it("读起来是「队友互相挑出了几处」，不是四个负面内部计数", () => {
    const line = formatCollabSummary({
      boundary_yields: 0,
      scope_signals: 1,
      revises: 2,
      escalations: 1,
    });
    expect(line).toBe("互相把关：发现跑偏 1 处 · 返工重写 2 处");
    expect(line).not.toMatch(/纠偏|漂移|唤回|上报/);
  });

  it("tooltip 解释这些词（旧文案一个词都不解释）", () => {
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("发现跑偏");
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("叫回重写");
  });
});
