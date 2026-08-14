import { describe, expect, it } from "vitest";
import { noticeSeverityTone } from "../ProductNoticeBanner";

describe("noticeSeverityTone", () => {
  it("maps critical and high to primary (needs you, not danger)", () => {
    expect(noticeSeverityTone("critical")).toBe("primary");
    expect(noticeSeverityTone("high")).toBe("primary");
  });

  it("maps other severities to muted", () => {
    expect(noticeSeverityTone("normal")).toBe("muted");
    expect(noticeSeverityTone("")).toBe("muted");
  });
});
