import { describe, expect, it } from "vitest";
import {
  HANGING_QUESTION_CAPTION,
  HANGING_QUESTION_CTA,
  formatHangingDefault,
} from "../hangingQuestion";

describe("hangingQuestion copy", () => {
  it("does not reuse the paused-checkpoint caption or CTA", () => {
    expect(HANGING_QUESTION_CAPTION).toBe("有事等你，团队照跑");
    expect(HANGING_QUESTION_CTA).toBe("答复");
    expect(HANGING_QUESTION_CAPTION).not.toMatch(/拍板|挂起|停工|暂停/);
    expect(HANGING_QUESTION_CTA).not.toBe("提交");
  });

  it("formats a default-continues hint from assumptions", () => {
    expect(
      formatHangingDefault([{ id: "a1", label: "格式", value: "仅 Markdown" }]),
    ).toBe("没回之前按这个继续：格式：仅 Markdown");
    expect(formatHangingDefault([])).toBeNull();
  });
});
