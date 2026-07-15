import { describe, expect, it } from "vitest";
import {
  type BackendMessage,
  shouldSetGeneratingOnHydrate,
  toMessage,
} from "../messages";

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

  it("maps status=running (no paused) to isStreaming for overlay partial", () => {
    const msg = toMessage(
      row({
        id: "m-live",
        role: "assistant",
        content: "partial…",
        status: "running",
      }),
    );
    expect(msg.isStreaming).toBe(true);
    expect(msg.finishReason).toBeUndefined();
    expect(shouldSetGeneratingOnHydrate([msg])).toBe(true);
  });

  it("maps status=running + paused to non-streaming finishReason=paused", () => {
    // Write latch keeps status=running; read lifts paused so reopen is not「仍在生成」.
    const msg = toMessage(
      row({
        id: "m-paused",
        role: "assistant",
        content: "checkpoint body",
        status: "running",
        paused: true,
      }),
    );
    expect(msg.isStreaming).toBe(false);
    expect(msg.finishReason).toBe("paused");
    expect(msg.status).toBe("running");
    expect(shouldSetGeneratingOnHydrate([msg])).toBe(false);
  });

  it("does not set generating chrome when last message is cold-paused", () => {
    const live = toMessage(
      row({ id: "m1", role: "user", content: "q", status: null }),
    );
    const paused = toMessage(
      row({
        id: "m2",
        role: "assistant",
        content: "a",
        status: "running",
        paused: true,
      }),
    );
    expect(shouldSetGeneratingOnHydrate([live, paused])).toBe(false);
  });
});
