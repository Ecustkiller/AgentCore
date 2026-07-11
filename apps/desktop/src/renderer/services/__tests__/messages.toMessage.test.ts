import { describe, expect, it } from "vitest";
import { type BackendMessage, toMessage } from "../messages";

/** Minimal persisted row — enough for `toMessage` hydrate assertions. */
function row(
  over: Partial<BackendMessage> & Pick<BackendMessage, "id" | "role">,
): BackendMessage {
  return {
    conversation_id: "c1",
    content: "hello",
    reasoning_content: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("toMessage (reload hydrate)", () => {
  it("stamps serverMessageId = row id on assistant so resume guards match live", () => {
    const msg = toMessage(
      row({ id: "srv-msg-1", role: "assistant", content: "ok" }),
    );

    expect(msg.id).toBe("srv-msg-1");
    expect(msg.role).toBe("assistant");
    expect(msg.serverMessageId).toBe("srv-msg-1");
  });

  it("does not stamp serverMessageId on user rows", () => {
    const msg = toMessage(
      row({ id: "srv-user-1", role: "user", content: "hi" }),
    );

    expect(msg.id).toBe("srv-user-1");
    expect(msg.role).toBe("user");
    expect(msg.serverMessageId).toBeUndefined();
  });
});
