import { describe, expect, it } from "vitest";
import {
  isResumeDeferredBusyReason,
  parseResumeDeferredPayload,
  resumeDeferredCardCopy,
} from "../resumeDeferred";

describe("resumeDeferred helpers", () => {
  it("parses wire payload", () => {
    expect(
      parseResumeDeferredPayload({
        message_id: "m1",
        conversation_id: "c1",
        busy_reason: "wrap_up",
      }),
    ).toEqual({
      message_id: "m1",
      conversation_id: "c1",
      busy_reason: "wrap_up",
    });
    expect(parseResumeDeferredPayload({ busy_reason: "nope" })).toBeNull();
    expect(isResumeDeferredBusyReason("live_turn")).toBe(true);
    expect(isResumeDeferredBusyReason("other")).toBe(false);
  });

  it("card copy is deferred-success，not turn_in_progress toast", () => {
    for (const reason of ["wrap_up", "live_turn"] as const) {
      const copy = resumeDeferredCardCopy(reason);
      expect(copy).toContain("放行已记下");
      expect(copy).toContain("停止");
      expect(copy).not.toContain("回合收尾尚未完成");
    }
  });
});
