import type { MemoryUpdate, Message } from "@/stores/conversation";
import { describe, expect, it } from "vitest";
import { mergeTimeline } from "../messageTimeline";

/**
 * mergeTimeline — 记忆卡不再按裸时间戳就地插，而是锚到「它所在那一回合的末尾」（AI 回答之后、
 * 下一次提问之前），既不夹进「提问↔回答」对里，又每回合各一张、按时间分布，不堆在对话底部
 * （记忆更新对话内可见 §1.6）。
 */

const um = (id: string, at: string): Message =>
  ({
    id,
    role: "user",
    content: "",
    createdAt: at,
    executionId: null,
    isStreaming: false,
  }) as Message;

const am = (id: string, at: string): Message =>
  ({
    id,
    role: "assistant",
    content: "",
    createdAt: at,
    executionId: null,
    isStreaming: false,
  }) as Message;

const mem = (id: string, at: string): MemoryUpdate => ({
  id,
  createdAt: at,
  items: [],
});

describe("mergeTimeline", () => {
  it("returns a pure message list when there are no tasks or memory cards", () => {
    const items = mergeTimeline(
      [um("u1", "2026-01-01T00:00:00Z"), am("a1", "2026-01-01T01:00:00Z")],
      [],
    );
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
    expect(items.map((i) => i.key)).toEqual(["m:u1", "m:a1"]);
  });

  it("pushes a mid-turn card to the exchange end, never between question and answer", () => {
    // The long turn's answer (a1) is stored with its turn-COMPLETION time (02:00); the
    // offline card consolidated at 01:00 — a raw time-sort would slip it between u1 and a1.
    // It must instead land AFTER the answer (end of the exchange).
    const messages = [
      um("u1", "2026-01-01T00:00:00Z"),
      am("a1", "2026-01-01T02:00:00Z"),
    ];
    const memory = [mem("mem1", "2026-01-01T01:00:00Z")];
    const items = mergeTimeline(messages, [], memory);
    expect(items.map((i) => i.key)).toEqual(["m:u1", "m:a1", "mem:mem1"]);
  });

  it("anchors each turn's card to its own exchange end, distributed not stacked", () => {
    const messages = [
      um("u1", "2026-01-01T00:00:00Z"),
      am("a1", "2026-01-01T01:00:00Z"),
      um("u2", "2026-01-01T02:00:00Z"),
      am("a2", "2026-01-01T05:00:00Z"),
    ];
    // Unsorted input; mem1 belongs to turn 1 (before u2), mem2 to turn 2 (tail).
    const memory = [
      mem("mem2", "2026-01-01T06:00:00Z"),
      mem("mem1", "2026-01-01T01:30:00Z"),
    ];
    const items = mergeTimeline(messages, [], memory);
    expect(items.map((i) => i.key)).toEqual([
      "m:u1",
      "m:a1",
      "mem:mem1",
      "m:u2",
      "m:a2",
      "mem:mem2",
    ]);
  });

  it("keeps a card whose timestamp lands inside a later long turn out of that turn's Q→A", () => {
    // turn-1 consolidation lagged into turn-2's window (03:00, between u2 and its 05:00
    // answer): it snaps to the tail of turn 2, not between u2 and a2.
    const messages = [
      um("u1", "2026-01-01T00:00:00Z"),
      am("a1", "2026-01-01T01:00:00Z"),
      um("u2", "2026-01-01T02:00:00Z"),
      am("a2", "2026-01-01T05:00:00Z"),
    ];
    const memory = [mem("memX", "2026-01-01T03:00:00Z")];
    const items = mergeTimeline(messages, [], memory);
    expect(items.map((i) => i.key)).toEqual([
      "m:u1",
      "m:a1",
      "m:u2",
      "m:a2",
      "mem:memX",
    ]);
  });

  it("places a card tied with a user message's timestamp at that exchange's end", () => {
    const messages = [
      um("u1", "2026-01-01T00:00:00Z"),
      am("a1", "2026-01-01T01:00:00Z"),
      um("u2", "2026-01-01T02:00:00Z"),
      am("a2", "2026-01-01T03:00:00Z"),
    ];
    const memory = [mem("memT", "2026-01-01T02:00:00Z")];
    const items = mergeTimeline(messages, [], memory);
    expect(items.map((i) => i.key)).toEqual([
      "m:u1",
      "m:a1",
      "m:u2",
      "m:a2",
      "mem:memT",
    ]);
  });
});
