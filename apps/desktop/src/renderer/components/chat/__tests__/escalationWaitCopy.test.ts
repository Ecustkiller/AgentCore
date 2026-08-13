/**
 * 「不答会怎样」文案 = 后端真实挂起口径（诚实性）。
 *
 * 默认部署无超时（checkpoint_timeout_seconds=None）：不答就一直挂着，卡面不得出现
 * 「未答则…继续」这类自动兜底承诺；运维配了上限的部署则要照实写出上限。
 */

import { describe, expect, it } from "vitest";
import { escalationWaitNote, waitCeilingLabel } from "../escalationWaitCopy";

describe("waitCeilingLabel", () => {
  it("returns nothing when ops configured no ceiling", () => {
    expect(waitCeilingLabel(undefined)).toBe("");
    expect(waitCeilingLabel(null)).toBe("");
    expect(waitCeilingLabel(0)).toBe("");
    expect(waitCeilingLabel(-1)).toBe("");
    expect(waitCeilingLabel(Number.NaN)).toBe("");
  });

  it("scales the unit to the configured ceiling", () => {
    expect(waitCeilingLabel(45)).toBe("45 秒");
    expect(waitCeilingLabel(60)).toBe("1 分钟");
    expect(waitCeilingLabel(900)).toBe("15 分钟");
    expect(waitCeilingLabel(1800)).toBe("30 分钟");
    expect(waitCeilingLabel(7200)).toBe("2 小时");
    expect(waitCeilingLabel(5400)).toBe("1.5 小时");
  });
});

describe("escalationWaitNote · 无超时部署（默认）", () => {
  it("never promises an unattended fallback", () => {
    const note = escalationWaitNote({ assumption: "暂按方案 A" });
    expect(note).toBe(
      "不会自动继续——这条一直等你；点「按假设继续」才按此走：暂按方案 A",
    );
    expect(note).not.toMatch(/未答则/);
  });

  it("says the CEO must rule for an arbitration card", () => {
    const note = escalationWaitNote({
      assumption: "暂按方案 A",
      awaiting: "ceo",
    });
    expect(note).toBe("不会自动继续——等主管裁决；暂定假设：暂按方案 A");
    expect(note).not.toMatch(/未裁则/);
  });

  it("still stands without an assumption", () => {
    expect(escalationWaitNote({ assumption: "  " })).toBe(
      "不会自动继续——这条一直等你",
    );
  });
});

describe("escalationWaitNote · 配了超时的部署", () => {
  it("states the real ceiling instead of hiding it", () => {
    expect(
      escalationWaitNote({ assumption: "暂按方案 A", timeoutSeconds: 1800 }),
    ).toBe("30 分钟内未答则按此继续：暂按方案 A");
  });

  it("keeps the 未裁 wording for CEO arbitration", () => {
    expect(
      escalationWaitNote({
        assumption: "暂按方案 A",
        timeoutSeconds: 900,
        awaiting: "ceo",
      }),
    ).toBe("15 分钟内未裁则按此继续：暂按方案 A");
  });
});
