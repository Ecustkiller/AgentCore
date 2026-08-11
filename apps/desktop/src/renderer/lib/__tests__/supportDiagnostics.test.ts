import { describe, expect, it } from "vitest";
import {
  formatSupportDiagnosticText,
  precedingUserMessageId,
  supportDiagnosticExtrasFromError,
} from "../supportDiagnostics";

describe("formatSupportDiagnosticText", () => {
  it("joins present ids and prefers --trace log command", () => {
    const trace = "t".repeat(32);
    expect(
      formatSupportDiagnosticText({
        conversationId: "conv-1",
        messageId: "msg-1",
        traceId: trace,
        executionId: "exec-1",
      }),
    ).toBe(
      [
        "阅读这段产品AI日志：",
        "conversation_id: conv-1",
        "message_id: msg-1",
        `trace_id: ${trace}`,
        "execution_id: exec-1",
        `uv run python scripts/log_timeline.py --trace ${trace}`,
      ].join("\n"),
    );
  });

  it("falls back to conversation_id log command when no trace", () => {
    expect(
      formatSupportDiagnosticText({
        conversationId: "conv-1",
        messageId: "msg-1",
        executionId: "exec-1",
      }),
    ).toBe(
      [
        "阅读这段产品AI日志：",
        "conversation_id: conv-1",
        "message_id: msg-1",
        "execution_id: exec-1",
        "uv run python scripts/log_timeline.py conv-1",
      ].join("\n"),
    );
  });

  it("omits optional ids and log command when nothing to query", () => {
    expect(
      formatSupportDiagnosticText({
        messageId: "msg-1",
        traceId: null,
        executionId: "  ",
      }),
    ).toBe(["阅读这段产品AI日志：", "message_id: msg-1"].join("\n"));
  });

  it("returns empty string when nothing to copy", () => {
    expect(formatSupportDiagnosticText({})).toBe("");
  });

  it("still returns empty when only extras are set (needs at least one id)", () => {
    expect(
      formatSupportDiagnosticText({
        errorCode: "LLM_EMPTY_RESPONSE",
        emptyDiagnosis: "silent_empty",
        bodyKind: "html",
        baseUrl: "https://api.example.com",
        stream: true,
      }),
    ).toBe("");
  });

  it("appends extras after ids when present", () => {
    expect(
      formatSupportDiagnosticText({
        conversationId: "conv-1",
        messageId: "msg-1",
        errorCode: "LLM_EMPTY_RESPONSE",
        emptyDiagnosis: "upstream_non_api",
        bodyKind: "html",
        baseUrl: "https://api.zdc.mom",
        stream: true,
      }),
    ).toBe(
      [
        "阅读这段产品AI日志：",
        "conversation_id: conv-1",
        "message_id: msg-1",
        "error_code: LLM_EMPTY_RESPONSE",
        "empty_diagnosis: upstream_non_api",
        "body_kind: html",
        "base_url: https://api.zdc.mom",
        "stream: true",
        "uv run python scripts/log_timeline.py conv-1",
      ].join("\n"),
    );
  });

  it("omits stream when not true and skips blank extras", () => {
    expect(
      formatSupportDiagnosticText({
        messageId: "msg-1",
        errorCode: "LLM_ERROR",
        emptyDiagnosis: "  ",
        stream: false,
      }),
    ).toBe(
      [
        "阅读这段产品AI日志：",
        "message_id: msg-1",
        "error_code: LLM_ERROR",
      ].join("\n"),
    );
  });

  it("lists user_message_id before assistant message_id for regenerate packs", () => {
    expect(
      formatSupportDiagnosticText({
        conversationId: "conv-1",
        messageId: "asst-client-uuid",
        userMessageId: "user-persisted",
      }),
    ).toBe(
      [
        "阅读这段产品AI日志：",
        "conversation_id: conv-1",
        "user_message_id: user-persisted",
        "message_id: asst-client-uuid",
        "uv run python scripts/log_timeline.py conv-1",
      ].join("\n"),
    );
  });
});

describe("supportDiagnosticExtrasFromError", () => {
  it("maps error fields and sets stream for empty_diagnosis", () => {
    expect(
      supportDiagnosticExtrasFromError({
        code: "LLM_EMPTY_RESPONSE",
        context: {
          empty_diagnosis: "silent_empty",
          body_kind: "empty",
          base_url: "https://api.example.com/v1",
        },
      }),
    ).toEqual({
      errorCode: "LLM_EMPTY_RESPONSE",
      emptyDiagnosis: "silent_empty",
      bodyKind: "empty",
      baseUrl: "https://api.example.com/v1",
      stream: true,
    });
  });

  it("sets stream for LLM_EMPTY_RESPONSE without empty_diagnosis", () => {
    expect(
      supportDiagnosticExtrasFromError({ code: "LLM_EMPTY_RESPONSE" }),
    ).toEqual({
      errorCode: "LLM_EMPTY_RESPONSE",
      stream: true,
    });
  });

  it("omits stream for unrelated errors", () => {
    expect(
      supportDiagnosticExtrasFromError({
        code: "LLM_ERROR",
        context: { body_kind: "json" },
      }),
    ).toEqual({
      errorCode: "LLM_ERROR",
      bodyKind: "json",
    });
  });
});

describe("precedingUserMessageId", () => {
  it("returns the nearest prior user bubble", () => {
    expect(
      precedingUserMessageId(
        [
          { id: "u1", role: "user" },
          { id: "a1", role: "assistant" },
          { id: "u2", role: "user" },
          { id: "a2", role: "assistant" },
        ],
        "a2",
      ),
    ).toBe("u2");
  });
});
