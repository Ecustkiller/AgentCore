import { describe, expect, it } from "vitest";
import { parseSidecarPreference } from "../ui";

describe("parseSidecarPreference", () => {
  it("三态字符串", () => {
    expect(parseSidecarPreference("on")).toBe("on");
    expect(parseSidecarPreference("off")).toBe("off");
    expect(parseSidecarPreference(undefined)).toBe("unset");
    expect(parseSidecarPreference("maybe")).toBe("unset");
  });

  it("兼容毕业前 boolean：false=显式关，true=显式开", () => {
    expect(parseSidecarPreference(false)).toBe("off");
    expect(parseSidecarPreference(true)).toBe("on");
  });
});
