import { describe, expect, it } from "vitest";
import { formatSupportDiagnosticText } from "../supportDiagnostics";

describe("formatSupportDiagnosticText", () => {
  it("joins present ids with support-friendly keys", () => {
    expect(
      formatSupportDiagnosticText({
        conversationId: "conv-1",
        traceId: "t".repeat(32),
        messageId: "msg-1",
      }),
    ).toBe(
      ["conversation_id: conv-1", `trace_id: ${"t".repeat(32)}`, "message_id: msg-1"].join(
        "\n",
      ),
    );
  });

  it("omits missing ids", () => {
    expect(
      formatSupportDiagnosticText({
        conversationId: "conv-1",
        traceId: null,
        messageId: "  ",
      }),
    ).toBe("conversation_id: conv-1");
  });

  it("returns empty string when nothing to copy", () => {
    expect(formatSupportDiagnosticText({})).toBe("");
  });
});
