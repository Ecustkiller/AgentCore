import { describe, expect, it } from "vitest";
import {
  DESKTOP_LOG_EXCERPT_MAX_EVENTS,
  isRelevantDesktopLogRecord,
  sanitizeDesktopLogLines,
  sanitizeDesktopLogRecord,
} from "../desktop-log-sanitize";

describe("sanitizeDesktopLogRecord", () => {
  it("keeps server_health / sse diagnostic fields", () => {
    expect(
      sanitizeDesktopLogRecord({
        timestamp: "2026-08-17T00:00:00.000Z",
        level: "warn",
        event: "server_health.offline",
        build: "prod",
        version: "1.2.3",
        fields: {
          source: "heartbeat",
          reason: "连不上 AgentCore 服务，请稍后重试。",
          last_ok_at: 1,
          from: "online",
          consecutive_failures: 3,
        },
      }),
    ).toEqual({
      timestamp: "2026-08-17T00:00:00.000Z",
      level: "warn",
      event: "server_health.offline",
      build: "prod",
      version: "1.2.3",
      source: "heartbeat",
      reason: "连不上 AgentCore 服务，请稍后重试。",
      last_ok_at: 1,
      from: "online",
      consecutive_failures: 3,
    });
  });

  it("drops conversation body, tokens, and file paths even if present", () => {
    expect(
      sanitizeDesktopLogRecord({
        event: "sse.idle_stall",
        fields: {
          conversation_id: "c1",
          content: "用户的整段提问",
          token: "sk-secret",
          authorization: "Bearer abc",
          path: "C:\\\\Users\\\\me\\\\secret.docx",
          filename: "secret.docx",
          message: "should not leave the machine",
        },
      }),
    ).toEqual({
      event: "sse.idle_stall",
      conversation_id: "c1",
    });
  });

  it("drops non-diagnostic events", () => {
    expect(
      sanitizeDesktopLogRecord({
        event: "conversation.slice_diag",
        fields: { action: "load_latest_window", conversation_id: "c1" },
      }),
    ).toBeNull();
  });
});

describe("sanitizeDesktopLogLines", () => {
  it("parses JSONL, drops junk / other conversations, caps the tail", () => {
    const lines = [
      "not-json",
      JSON.stringify({
        event: "server_health.online",
        fields: { since_offline_ms: 12 },
      }),
      JSON.stringify({
        event: "sse.idle_stall",
        fields: { conversation_id: "other" },
      }),
      JSON.stringify({
        event: "sse.idle_stall",
        fields: { conversation_id: "mine", content: "秘密正文" },
      }),
    ];
    const out = sanitizeDesktopLogLines(`partial-prefix\n${lines.join("\n")}`, {
      conversationId: "mine",
    });
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { event: "server_health.online", since_offline_ms: 12 },
      { event: "sse.idle_stall", conversation_id: "mine" },
    ]);
    expect(out.join("\n")).not.toContain("秘密正文");
  });

  it("keeps server_health lines that have no conversation_id when packing a chat", () => {
    expect(
      isRelevantDesktopLogRecord(
        { event: "server_health.offline", source: "heartbeat" },
        "mine",
      ),
    ).toBe(true);
    expect(
      isRelevantDesktopLogRecord(
        { event: "sse.idle_stall", conversation_id: "other" },
        "mine",
      ),
    ).toBe(false);
    expect(
      isRelevantDesktopLogRecord(
        { event: "sse.forced_transport_drop" },
        "mine",
      ),
    ).toBe(true);
  });

  it("does not drop an early server_health.offline under a flood of scoped retries", () => {
    const rows = [
      JSON.stringify({
        event: "server_health.offline",
        fields: { source: "heartbeat" },
      }),
      ...Array.from({ length: DESKTOP_LOG_EXCERPT_MAX_EVENTS + 20 }, (_, i) =>
        JSON.stringify({
          event: "conversation.rejoin_retry",
          fields: { conversation_id: "mine", attempt: i },
        }),
      ),
    ];
    const out = sanitizeDesktopLogLines(rows.join("\n"), {
      conversationId: "mine",
    });
    const events = out.map((line) => JSON.parse(line).event);
    expect(events).toContain("server_health.offline");
    expect(out.length).toBeLessThanOrEqual(DESKTOP_LOG_EXCERPT_MAX_EVENTS);
  });

  it("caps scoped noise but keeps the newest ambient health edges", () => {
    const rows = Array.from(
      { length: DESKTOP_LOG_EXCERPT_MAX_EVENTS + 5 },
      (_, i) =>
        JSON.stringify({
          event: "server_health.probe_failed",
          fields: { attempt: i },
        }),
    );
    const out = sanitizeDesktopLogLines(rows.join("\n"));
    expect(out).toHaveLength(DESKTOP_LOG_EXCERPT_MAX_EVENTS);
    expect(JSON.parse(out[0] ?? "{}").attempt).toBe(5);
  });
});
