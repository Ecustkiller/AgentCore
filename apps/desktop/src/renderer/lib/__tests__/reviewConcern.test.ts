import { describe, expect, it } from "vitest";
import { detectReviewConcern } from "../reviewConcern";

describe("detectReviewConcern", () => {
  it("flags low numeric scores", () => {
    expect(detectReviewConcern("语言体验 7/10，有几处可优化")).toBe("warning");
    expect(detectReviewConcern("综合评分 4/10，问题较多")).toBe("critical");
  });

  it("flags direction-critical wording", () => {
    expect(detectReviewConcern("整体方向偏书面，建议重写")).toBe("critical");
  });

  it("ignores short or neutral text", () => {
    expect(detectReviewConcern("ok")).toBeNull();
    expect(detectReviewConcern("语法通顺，微调两处即可。")).toBeNull();
  });
});
