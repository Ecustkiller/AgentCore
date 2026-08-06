import { describe, expect, it } from "vitest";
import { formatDebateBudgetLabel } from "../budget";

describe("formatDebateBudgetLabel", () => {
  it("认真辩透带轮次时含「上限」", () => {
    expect(formatDebateBudgetLabel(5, true)).toBe("认真辩透 · 上限 5 轮");
  });

  it("快速对碰带轮次", () => {
    expect(formatDebateBudgetLabel(3, false)).toBe("快速对碰 · 3 轮");
  });

  it("无轮次时仅模式文案", () => {
    expect(formatDebateBudgetLabel(0, true)).toBe("认真辩透");
    expect(formatDebateBudgetLabel(0, false)).toBe("快速对碰");
  });
});
