import { describe, expect, it } from "vitest";
import {
  type ActiveConversation,
  conversationIdFromHash,
  deriveActiveConversations,
  isTransientRoute,
  runtimeHasError,
  summarizeActivity,
} from "../teamActivity";

const title = (map: Record<string, string>) => (id: string) => map[id];

describe("deriveActiveConversations", () => {
  it("maps generating + awaiting ids to titled rows", () => {
    const active = deriveActiveConversations(
      ["a", "b"],
      ["c"],
      title({ a: "对话 A", b: "对话 B", c: "对话 C" }),
    );
    expect(active).toEqual<ActiveConversation[]>([
      { id: "c", title: "对话 C", status: "awaiting" },
      { id: "a", title: "对话 A", status: "running" },
      { id: "b", title: "对话 B", status: "running" },
    ]);
  });

  it("dedups a conversation that is both generating and awaiting (awaiting wins)", () => {
    const active = deriveActiveConversations(
      ["a"],
      ["a"],
      title({ a: "对话 A" }),
    );
    expect(active).toEqual<ActiveConversation[]>([
      { id: "a", title: "对话 A", status: "awaiting" },
    ]);
  });

  it("falls back to a generic title when unknown", () => {
    const active = deriveActiveConversations(["x"], [], () => undefined);
    expect(active).toEqual<ActiveConversation[]>([
      { id: "x", title: "对话", status: "running" },
    ]);
  });

  it("is empty when nothing is active", () => {
    expect(deriveActiveConversations([], [], () => "t")).toEqual([]);
  });
});

describe("summarizeActivity", () => {
  it("returns null with no activity", () => {
    expect(summarizeActivity([])).toBeNull();
  });

  it("counts running only", () => {
    expect(
      summarizeActivity([
        { id: "a", title: "A", status: "running" },
        { id: "b", title: "B", status: "running" },
      ]),
    ).toBe("2 个任务执行中");
  });

  it("counts awaiting only", () => {
    expect(
      summarizeActivity([{ id: "a", title: "A", status: "awaiting" }]),
    ).toBe("1 个待审批");
  });

  it("joins both with a middot", () => {
    expect(
      summarizeActivity([
        { id: "a", title: "A", status: "running" },
        { id: "b", title: "B", status: "awaiting" },
      ]),
    ).toBe("1 个任务执行中 · 1 个待审批");
  });
});

describe("runtimeHasError", () => {
  it("is false for a clean completed turn", () => {
    expect(
      runtimeHasError({
        error: null,
        messages: [{ role: "user" }, { role: "assistant", error: undefined }],
      }),
    ).toBe(false);
  });

  it("detects the SSE error path (last assistant message stamped)", () => {
    expect(
      runtimeHasError({
        error: null,
        messages: [
          { role: "user" },
          { role: "assistant", error: { code: "x", message: "boom" } },
        ],
      }),
    ).toBe(true);
  });

  it("detects the transport-drop path (runtime-level error string)", () => {
    expect(
      runtimeHasError({ error: "网络中断", messages: [{ role: "user" }] }),
    ).toBe(true);
  });

  it("reads only the LAST assistant message", () => {
    expect(
      runtimeHasError({
        error: null,
        messages: [
          { role: "assistant", error: { code: "old", message: "prev" } },
          { role: "assistant", error: undefined },
        ],
      }),
    ).toBe(false);
  });
});

describe("conversationIdFromHash", () => {
  it("extracts the id from a conversation route", () => {
    expect(conversationIdFromHash("#/conversations/abc123")).toBe("abc123");
  });

  it("ignores the msg query anchor", () => {
    expect(conversationIdFromHash("#/conversations/abc?msg=m1")).toBe("abc");
  });

  it("returns null off the conversation route", () => {
    expect(conversationIdFromHash("#/files")).toBeNull();
    expect(conversationIdFromHash("#/")).toBeNull();
    expect(conversationIdFromHash("#/conversations")).toBeNull();
  });
});

describe("isTransientRoute", () => {
  it("flags preview and simulation surfaces", () => {
    expect(isTransientRoute("#/preview")).toBe(true);
    expect(isTransientRoute("#/preview/whiteboard")).toBe(true);
    expect(isTransientRoute("#/simulation/town")).toBe(true);
  });

  it("is false for real app routes", () => {
    expect(isTransientRoute("#/conversations/abc")).toBe(false);
    expect(isTransientRoute("#/files")).toBe(false);
  });
});
