import type { Message } from "@/stores/conversation";
import { describe, expect, it } from "vitest";
import {
  adoptLatestWindowMessages,
  hasUnconfirmedLocalTail,
  reusableSendAssistantId,
  unconfirmedLocalTail,
} from "../messageWindowWrite";

function msg(
  id: string,
  role: "user" | "assistant",
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    content,
    createdAt: "",
    executionId: null,
    isStreaming: false,
    ...extra,
  };
}

describe("unconfirmedLocalTail", () => {
  it("is the streaming assistant without a server id, plus the user in front", () => {
    const existing = [
      msg("m1", "user", "old"),
      msg("m2", "assistant", "done"),
      msg("u-opt", "user", "hello"),
      msg("a-opt", "assistant", "", { isStreaming: true }),
    ];
    expect(unconfirmedLocalTail(existing).map((m) => m.id)).toEqual([
      "u-opt",
      "a-opt",
    ]);
    expect(hasUnconfirmedLocalTail(existing)).toBe(true);
  });

  it("treats an empty generating placeholder as the same tail (orphan-settled)", () => {
    const existing = [
      msg("u-opt", "user", "hello"),
      msg("a-opt", "assistant", "", { isStreaming: false }),
    ];
    expect(unconfirmedLocalTail(existing)).toEqual([]);
    expect(
      unconfirmedLocalTail(existing, { isGenerating: true }).map((m) => m.id),
    ).toEqual(["u-opt", "a-opt"]);
  });

  it("is empty once the assistant has a server id or has finished", () => {
    expect(
      unconfirmedLocalTail([
        msg("u1", "user", "hi"),
        msg("a1", "assistant", "", {
          isStreaming: true,
          serverMessageId: "srv-a",
        }),
      ]),
    ).toEqual([]);
    expect(
      unconfirmedLocalTail([
        msg("u1", "user", "hi"),
        msg("a1", "assistant", "partial"),
      ]),
    ).toEqual([]);
  });
});

describe("reusableSendAssistantId", () => {
  it("returns the clean streaming empty assistant right after the user", () => {
    expect(
      reusableSendAssistantId(
        [
          msg("u-opt", "user", "hello"),
          msg("a-opt", "assistant", "", { isStreaming: true }),
        ],
        "u-opt",
      ),
    ).toBe("a-opt");
  });

  it("still matches after orphan settle cleared isStreaming", () => {
    expect(
      reusableSendAssistantId(
        [msg("u-opt", "user", "hello"), msg("a-opt", "assistant", "")],
        "u-opt",
      ),
    ).toBe("a-opt");
  });

  it("does not reuse a leftover with body, server id, or incomplete status", () => {
    expect(
      reusableSendAssistantId(
        [msg("u-opt", "user", "hello"), msg("a1", "assistant", "partial")],
        "u-opt",
      ),
    ).toBeUndefined();
    expect(
      reusableSendAssistantId(
        [
          msg("u-opt", "user", "hello"),
          msg("a1", "assistant", "", {
            isStreaming: true,
            serverMessageId: "srv",
          }),
        ],
        "u-opt",
      ),
    ).toBeUndefined();
    expect(
      reusableSendAssistantId(
        [
          msg("u-opt", "user", "hello"),
          msg("a1", "assistant", "", { status: "incomplete" }),
        ],
        "u-opt",
      ),
    ).toBeUndefined();
  });

  it("does not reuse when extra messages sit after the user", () => {
    expect(
      reusableSendAssistantId(
        [
          msg("u-opt", "user", "hello"),
          msg("a1", "assistant", "", { isStreaming: true }),
          msg("a2", "assistant", "", { isStreaming: true }),
        ],
        "u-opt",
      ),
    ).toBeUndefined();
  });
});

describe("adoptLatestWindowMessages", () => {
  it("replaces the whole window when there is no unconfirmed tail", () => {
    const existing = [
      msg("m1", "user", "hi"),
      msg("m2", "assistant", "partial"),
    ];
    const incoming = [...existing, msg("m3", "user", "next")];
    expect(
      adoptLatestWindowMessages(incoming, existing).map((m) => m.id),
    ).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps optimistic Thinking when REST is still the previous window", () => {
    const thinking = msg("a-opt", "assistant", "", { isStreaming: true });
    const existing = [
      msg("m1", "user", "old"),
      msg("m2", "assistant", "done"),
      msg("u-opt", "user", "hello"),
      thinking,
    ];
    const incoming = [msg("m1", "user", "old"), msg("m2", "assistant", "done")];
    const applied = adoptLatestWindowMessages(incoming, existing);
    expect(applied.map((m) => m.id)).toEqual(["m1", "m2", "u-opt", "a-opt"]);
    expect(applied.at(-1)?.isStreaming).toBe(true);
  });

  it("stamps a same-content REST user onto the optimistic user instead of duplicating", () => {
    const existing = [
      msg("m1", "user", "old"),
      msg("m2", "assistant", "done"),
      msg("u-opt", "user", "hello"),
      msg("a-opt", "assistant", "", { isStreaming: true }),
    ];
    const incoming = [
      msg("m1", "user", "old"),
      msg("m2", "assistant", "done"),
      msg("u-srv", "user", "hello"),
    ];
    const applied = adoptLatestWindowMessages(incoming, existing);
    expect(applied.map((m) => m.id)).toEqual(["m1", "m2", "u-opt", "a-opt"]);
    expect(applied.find((m) => m.id === "u-opt")?.serverMessageId).toBe(
      "u-srv",
    );
    expect(applied.at(-1)?.isStreaming).toBe(true);
  });
});
