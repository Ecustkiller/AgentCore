import { lineDiff } from "@/lib/lineDiff";
import { describe, expect, it } from "vitest";

describe("lineDiff", () => {
  it("marks changed lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  it("marks insertions", () => {
    expect(lineDiff("a\nc", "a\nb\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "add", text: "b" },
      { type: "context", text: "c" },
    ]);
  });
});
