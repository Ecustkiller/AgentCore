import {
  type AnchorableMessage,
  memoryAnchorMs,
  placeMemoryUpdates,
} from "@/lib/memoryAnchors";
import { describe, expect, it } from "vitest";

interface TestUpdate {
  id: string;
  createdAt: string;
  anchorAt?: string | null;
}

function msg(
  id: string,
  role: "user" | "assistant",
  created_at: string,
): AnchorableMessage {
  return { id, role, created_at };
}

// 两轮问答：u1 → a1（第一轮）, u2 → a2（第二轮）。
const TWO_TURNS: AnchorableMessage[] = [
  msg("u1", "user", "2026-08-13T10:00:00Z"),
  msg("a1", "assistant", "2026-08-13T10:00:30Z"),
  msg("u2", "user", "2026-08-13T10:05:00Z"),
  msg("a2", "assistant", "2026-08-13T10:05:40Z"),
];

// 再接一轮，用来区分「锚到第二轮末尾」与「没有更晚回合只好落尾部」。
const THREE_TURNS: AnchorableMessage[] = [
  ...TWO_TURNS,
  msg("u3", "user", "2026-08-13T10:09:00Z"),
  msg("a3", "assistant", "2026-08-13T10:09:30Z"),
];

describe("placeMemoryUpdates", () => {
  it("anchors a card to the end of the turn it summarizes, not the thread tail", () => {
    // 第一轮跑完才固化（createdAt 晚于第二轮提问），但 anchorAt 指着第一轮末尾。
    const update: TestUpdate = {
      id: "m1",
      createdAt: "2026-08-13T10:06:10Z",
      anchorAt: "2026-08-13T10:00:30Z",
    };

    const placed = placeMemoryUpdates(TWO_TURNS, [update]);

    expect(placed.before.get("u2")).toEqual([update]);
    expect(placed.tail).toEqual([]);
  });

  it("falls back to createdAt when anchorAt is absent (semantic / quota cards)", () => {
    const semantic: TestUpdate = {
      id: "s1",
      createdAt: "2026-08-13T10:01:00Z",
    };
    const nulled: TestUpdate = {
      id: "s2",
      createdAt: "2026-08-13T10:02:00Z",
      anchorAt: null,
    };

    const placed = placeMemoryUpdates(TWO_TURNS, [nulled, semantic]);

    // 两张都落在第一轮之后、第二轮提问之前，且按锚点升序。
    expect(placed.before.get("u2")).toEqual([semantic, nulled]);
    expect(placed.tail).toEqual([]);
  });

  it("keeps a card whose anchor is later than every user message at the tail", () => {
    const latest: TestUpdate = {
      id: "m2",
      createdAt: "2026-08-13T10:06:00Z",
      anchorAt: "2026-08-13T10:05:40Z",
    };

    const placed = placeMemoryUpdates(TWO_TURNS, [latest]);

    expect(placed.before.size).toBe(0);
    expect(placed.tail).toEqual([latest]);
  });

  it("spreads cards across the turns they summarize", () => {
    const first: TestUpdate = {
      id: "m1",
      createdAt: "2026-08-13T10:06:10Z",
      anchorAt: "2026-08-13T10:00:30Z",
    };
    const second: TestUpdate = {
      id: "m2",
      createdAt: "2026-08-13T10:06:20Z",
      anchorAt: "2026-08-13T10:05:40Z",
    };

    // 乱序输入也要各归各轮（旧的那张不能被新的挤到尾部）。
    const placed = placeMemoryUpdates(TWO_TURNS, [second, first]);

    expect(placed.before.get("u2")).toEqual([first]);
    expect(placed.tail).toEqual([second]);
  });

  it("treats only user messages as turn boundaries", () => {
    // 锚点落在 u2 与 a2 之间：助手回复属于第二轮，卡不能插到 a2 之前把问答对劈开。
    const update: TestUpdate = {
      id: "m1",
      createdAt: "2026-08-13T10:10:00Z",
      anchorAt: "2026-08-13T10:05:10Z",
    };

    const placed = placeMemoryUpdates(THREE_TURNS, [update]);

    expect(placed.before.get("a2")).toBeUndefined();
    expect(placed.before.get("u3")).toEqual([update]);
    expect(placed.tail).toEqual([]);
  });

  it("puts a card anchored exactly at a user message after that message", () => {
    // 同刻 = 那条提问本身就在固化窗口内，归下一个边界。
    const update: TestUpdate = {
      id: "m1",
      createdAt: "2026-08-13T10:10:00Z",
      anchorAt: "2026-08-13T10:05:00Z",
    };

    const placed = placeMemoryUpdates(THREE_TURNS, [update]);

    expect(placed.before.get("u2")).toBeUndefined();
    expect(placed.before.get("u3")).toEqual([update]);
  });

  it("groups several cards landing on the same boundary, oldest first", () => {
    const older: TestUpdate = {
      id: "m1",
      createdAt: "2026-08-13T10:06:10Z",
      anchorAt: "2026-08-13T10:00:10Z",
    };
    const newer: TestUpdate = {
      id: "m2",
      createdAt: "2026-08-13T10:06:20Z",
      anchorAt: "2026-08-13T10:00:30Z",
    };

    const placed = placeMemoryUpdates(TWO_TURNS, [newer, older]);

    expect(placed.before.get("u2")).toEqual([older, newer]);
    expect(placed.tail).toEqual([]);
  });

  it("returns nothing to render when there are no updates", () => {
    const placed = placeMemoryUpdates(TWO_TURNS, []);

    expect(placed.before.size).toBe(0);
    expect(placed.tail).toEqual([]);
  });

  it("keeps cards at the tail when no message is loaded", () => {
    const update: TestUpdate = { id: "m1", createdAt: "2026-08-13T10:00:00Z" };

    const placed = placeMemoryUpdates([], [update]);

    expect(placed.tail).toEqual([update]);
  });
});

describe("memoryAnchorMs", () => {
  it("prefers anchorAt over createdAt", () => {
    expect(
      memoryAnchorMs({
        createdAt: "2026-08-13T10:06:00Z",
        anchorAt: "2026-08-13T10:00:30Z",
      }),
    ).toBe(Date.parse("2026-08-13T10:00:30Z"));
  });

  it("degrades an unparsable timestamp to the thread head rather than NaN", () => {
    expect(memoryAnchorMs({ createdAt: "not-a-date" })).toBe(0);
  });
});
