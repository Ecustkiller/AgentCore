import type { SSEEvent } from "@agentcore/contract-types";
import { describe, expect, it } from "vitest";
import { inspectZeroOutputSendRollback } from "../zeroOutputSendRollback";

function ev(type: SSEEvent["type"], payload: unknown): SSEEvent {
  return { type, timestamp: "", payload } as SSEEvent;
}

const persistedEmptyRateLimit: SSEEvent[] = [
  ev("turn_saved", { user_message_id: "u1" }),
  ev("message_start", { message_id: "m1", conversation_id: "c1" }),
  ev("error", {
    code: "LLM_RATE_LIMIT",
    message: "上游限流，本回合无法继续。",
  }),
  ev("message_end", { finish_reason: "error" }),
];

describe("inspectZeroOutputSendRollback", () => {
  it("rolls back persisted empty failure with Class B codes", () => {
    for (const code of [
      "LLM_RATE_LIMIT",
      "LLM_KEY_INVALID",
      "LLM_INSUFFICIENT_BALANCE",
    ]) {
      const events = persistedEmptyRateLimit.map((e) =>
        e.type === "error" ? ev("error", { code, message: "失败" }) : e,
      );
      const d = inspectZeroOutputSendRollback(events);
      expect(d.rollback).toBe(true);
      expect(d.errorCode).toBe(code);
      expect(d.errorMessage).toBe("失败");
    }
  });

  it("does not roll back when the user message never persisted (Class A lane)", () => {
    expect(
      inspectZeroOutputSendRollback([
        ev("error", { code: "LLM_RATE_LIMIT", message: "限流" }),
        ev("message_end", { finish_reason: "error" }),
      ]).rollback,
    ).toBe(false);
  });

  it("does not treat Class A codes as Class B even after persist", () => {
    expect(
      inspectZeroOutputSendRollback([
        ev("turn_saved", { user_message_id: "u1" }),
        ev("error", { code: "LLM_KEY_REQUIRED", message: "缺 Key" }),
        ev("message_end", { finish_reason: "error" }),
      ]).rollback,
    ).toBe(false);
    expect(
      inspectZeroOutputSendRollback([
        ev("turn_saved", { user_message_id: "u1" }),
        ev("error", { code: "QUOTA_EXCEEDED", message: "额度" }),
        ev("message_end", { finish_reason: "error" }),
      ]).rollback,
    ).toBe(false);
  });

  it("keeps the turn when the assistant already has body", () => {
    expect(
      inspectZeroOutputSendRollback([
        ...persistedEmptyRateLimit.slice(0, 2),
        ev("content_delta", { delta: "半句" }),
        ev("error", { code: "LLM_RATE_LIMIT", message: "限流" }),
        ev("message_end", { finish_reason: "error" }),
      ]).rollback,
    ).toBe(false);
  });

  it("keeps the turn when a tool already started", () => {
    expect(
      inspectZeroOutputSendRollback([
        ...persistedEmptyRateLimit.slice(0, 2),
        ev("tool_use_start", {
          tool_call_id: "t1",
          tool_name: "web_search",
          arguments: {},
        }),
        ev("error", { code: "LLM_RATE_LIMIT", message: "限流" }),
        ev("message_end", { finish_reason: "error" }),
      ]).rollback,
    ).toBe(false);
  });

  it("treats content_reset as no body (rewritten empty)", () => {
    expect(
      inspectZeroOutputSendRollback([
        ev("turn_saved", { user_message_id: "u1" }),
        ev("content_delta", { delta: "草稿" }),
        ev("content_reset", { reason: "retry" }),
        ev("error", { code: "LLM_KEY_INVALID", message: "Key 无效" }),
        ev("message_end", { finish_reason: "error" }),
      ]).rollback,
    ).toBe(true);
  });
});
