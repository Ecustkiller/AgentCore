import {
  conversationHasFileArtifacts,
  conversationHasRestorableEntry,
  shouldIncludeChangesTurn,
} from "@/lib/conversationFileChanges";
import type { Message } from "@/stores/conversation/types";
import type { ProcessStep } from "@/types/events";
import { describe, expect, it } from "vitest";

function toolStep(
  tool_name: string,
  args: Record<string, unknown>,
): ProcessStep {
  return {
    kind: "tool",
    id: `t-${tool_name}`,
    tool_name,
    arguments: args,
    result: null,
    status: "success",
  };
}

function msg(
  partial: Partial<Message> & Pick<Message, "id" | "role">,
): Message {
  return {
    content: "",
    createdAt: new Date().toISOString(),
    executionId: null,
    isStreaming: false,
    ...partial,
  };
}

describe("conversationHasFileArtifacts", () => {
  it("is false when there are no assistant file ops", () => {
    expect(
      conversationHasFileArtifacts(
        [
          msg({ id: "u1", role: "user", content: "hi" }),
          msg({ id: "a1", role: "assistant", content: "ok" }),
        ],
        {},
      ),
    ).toBe(false);
  });

  it("is true when process has a successful file write", () => {
    expect(
      conversationHasFileArtifacts(
        [
          msg({
            id: "a1",
            role: "assistant",
            process: [toolStep("file_write", { path: "a.ts", content: "x" })],
          }),
        ],
        {},
      ),
    ).toBe(true);
  });
});

describe("conversationHasRestorableEntry (P0c)", () => {
  it("is true when only a Local baseline exists (no file_*)", () => {
    expect(
      conversationHasRestorableEntry(
        [
          msg({ id: "u1", role: "user", content: "hi" }),
          msg({ id: "a1", role: "assistant", content: "ran script" }),
        ],
        {},
        new Set(["a1"]),
      ),
    ).toBe(true);
  });

  it("is false when baseline ids do not match this conversation", () => {
    expect(
      conversationHasRestorableEntry(
        [msg({ id: "a1", role: "assistant", content: "ok" })],
        {},
        new Set(["other-turn"]),
      ),
    ).toBe(false);
  });
});

describe("shouldIncludeChangesTurn (P0c)", () => {
  it("includes baseline-only turns", () => {
    expect(
      shouldIncludeChangesTurn({
        artifactsLength: 0,
        messageId: "m1",
        baselineMessageIds: new Set(["m1"]),
        focusMessageId: null,
      }),
    ).toBe(true);
  });

  it("still includes file_* turns without baseline", () => {
    expect(
      shouldIncludeChangesTurn({
        artifactsLength: 2,
        messageId: "m1",
        baselineMessageIds: new Set(),
        focusMessageId: null,
      }),
    ).toBe(true);
  });

  it("skips turns with neither artifacts nor baseline nor focus", () => {
    expect(
      shouldIncludeChangesTurn({
        artifactsLength: 0,
        messageId: "m1",
        baselineMessageIds: new Set(["other"]),
        focusMessageId: null,
      }),
    ).toBe(false);
  });
});
