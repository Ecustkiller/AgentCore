import { MAX_MARKDOWN_CHARS, parseDocBody } from "@/lib/docBody";
import { describe, expect, it } from "vitest";

describe("parseDocBody", () => {
  it("keeps markdown and clips length", () => {
    expect(parseDocBody({ markdown: "# 结论\n\n正文" })).toEqual({
      markdown: "# 结论\n\n正文",
    });
    expect(parseDocBody("# 直接字符串")).toEqual({ markdown: "# 直接字符串" });
    const long = "x".repeat(MAX_MARKDOWN_CHARS + 10);
    expect(parseDocBody({ markdown: long }).markdown).toHaveLength(
      MAX_MARKDOWN_CHARS,
    );
  });

  it("returns empty body for garbage and legacy block payloads", () => {
    expect(parseDocBody(null)).toEqual({ markdown: "" });
    expect(
      parseDocBody({ blocks: [{ type: "paragraph", text: "旧稿" }] }),
    ).toEqual({ markdown: "" });
    expect(parseDocBody({ markdown: 3 })).toEqual({ markdown: "" });
  });
});
