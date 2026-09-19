import {
  APPROVAL_FACE_CHARS,
  APPROVAL_FACE_LINES,
  approvalBodyNeedsClip,
  countApprovalLines,
  firstApprovalLine,
} from "@/components/chat/approvalPreview";
import { describe, expect, it } from "vitest";

describe("approvalPreview", () => {
  it("counts logical lines and ignores a trailing newline", () => {
    expect(countApprovalLines("")).toBe(0);
    expect(countApprovalLines("hello")).toBe(1);
    expect(countApprovalLines("a\nb\nc")).toBe(3);
    expect(countApprovalLines("a\nb\nc\n")).toBe(3);
  });

  it("clips when the body is more than three lines or too long", () => {
    expect(approvalBodyNeedsClip("hello body")).toBe(false);
    expect(approvalBodyNeedsClip("a\nb\nc")).toBe(false);
    expect(approvalBodyNeedsClip("a\nb\nc\nd")).toBe(true);
    expect(approvalBodyNeedsClip("x".repeat(APPROVAL_FACE_CHARS + 1))).toBe(
      true,
    );
    expect(APPROVAL_FACE_LINES).toBe(3);
  });

  it("takes the first logical line for a compact replace summary", () => {
    expect(firstApprovalLine("alpha\nbeta\n")).toBe("alpha");
  });
});
