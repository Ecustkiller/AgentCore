/**
 * 「不答会怎样」文案 = 后端真实挂起口径（诚实性）。
 *
 * 默认部署无超时：不答就一直挂着，卡面不得出现「未答则…继续」这类自动兜底承诺；
 * 运维配了上限的部署则要照实写出上限。
 */

import { escalationWaitNote, waitCeilingLabel } from "@/lib/escalationWaitCopy";
import { describe, expect, it } from "vitest";

describe("waitCeilingLabel", () => {
  it("returns nothing when ops configured no ceiling", () => {
    expect(waitCeilingLabel(undefined)).toBe("");
    expect(waitCeilingLabel(null)).toBe("");
    expect(waitCeilingLabel(0)).toBe("");
    expect(waitCeilingLabel(-1)).toBe("");
  });

  it("scales the unit to the configured ceiling", () => {
    expect(waitCeilingLabel(45)).toBe("45 秒");
    expect(waitCeilingLabel(900)).toBe("15 分钟");
    expect(waitCeilingLabel(7200)).toBe("2 小时");
  });
});

describe("escalationWaitNote", () => {
  it("promises no unattended fallback on the default deployment", () => {
    const note = escalationWaitNote({ assumption: "暂按方案 A" });
    expect(note).toBe(
      "不会自动继续——这条一直等你；点「按假设继续」才按此走：暂按方案 A",
    );
    expect(note).not.toMatch(/未答则/);
  });

  it("states the real ceiling when ops configured one", () => {
    expect(
      escalationWaitNote({ assumption: "暂按方案 A", timeoutSeconds: 1800 }),
    ).toBe("30 分钟内未答则按此继续：暂按方案 A");
  });

  it("waits on the CEO for an arbitration card", () => {
    expect(
      escalationWaitNote({ assumption: "暂按方案 A", awaiting: "ceo" }),
    ).toBe("不会自动继续——等主管裁决；暂定假设：暂按方案 A");
  });
});
