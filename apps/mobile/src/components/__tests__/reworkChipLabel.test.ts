import { describe, expect, it } from "vitest";
import { reworkChipLabel } from "../ProcessTimeline";

describe("reworkChipLabel (mobile)", () => {
  it("streaming with no content after rework → in-progress copy", () => {
    expect(reworkChipLabel(true, false)).toBe("正在按规则修订…");
  });

  it("streaming with content after rework → completed copy", () => {
    expect(reworkChipLabel(true, true)).toBe("引用/格式核验后已重写");
  });

  it("settled without content after → completed copy", () => {
    expect(reworkChipLabel(false, false)).toBe("引用/格式核验后已重写");
  });

  it("settled with content after → completed copy", () => {
    expect(reworkChipLabel(false, true)).toBe("引用/格式核验后已重写");
  });
});
