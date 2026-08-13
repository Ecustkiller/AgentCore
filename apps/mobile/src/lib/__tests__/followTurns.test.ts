import {
  type FoldedTurnLike,
  planFollowSegment,
  turnMessageId,
} from "@/lib/followTurns";
import { describe, expect, it } from "vitest";

const start = (id: string) => ({
  type: "message_start",
  payload: { message_id: id },
});
const delta = { type: "content_delta", payload: { text: "hi" } };
const end = { type: "message_end", payload: {} };

/** 计数器代替 crypto.randomUUID，让「新开气泡」可断言。 */
function ids() {
  let n = 0;
  return () => `new-${++n}`;
}

function plan(
  cursor: Parameters<typeof planFollowSegment>[0]["cursor"],
  messageId: string,
  opts: { adopt?: string | null; turns?: FoldedTurnLike[] } = {},
) {
  return planFollowSegment({
    cursor,
    messageId,
    adoptTurnId: opts.adopt ?? null,
    turns: opts.turns ?? [],
    newTurnId: ids(),
  });
}

describe("turnMessageId", () => {
  it("取 message_start 的 message_id；没有则 null", () => {
    expect(turnMessageId([start("m1"), delta])).toBe("m1");
    expect(turnMessageId([delta])).toBeNull();
    expect(turnMessageId([])).toBeNull();
  });
});

describe("planFollowSegment", () => {
  it("空闲订阅上另一端起的回合 → 新开气泡", () => {
    const p = plan(null, "m1");
    expect(p.action).toBe("open");
    expect(p.cursor).toEqual({ messageId: "m1", turnId: "new-1" });
  });

  it("同一回合的后续帧继续折进同一个气泡", () => {
    const cursor = { messageId: "m1", turnId: "t1" };
    const p = plan(cursor, "");
    expect(p.action).toBe("continue");
    expect(p.cursor.turnId).toBe("t1");
  });

  it("同一连接上的下一个回合 → 另开气泡（不复用上一段）", () => {
    const p = plan({ messageId: "m1", turnId: "t1" }, "m2");
    expect(p.action).toBe("open");
    expect(p.cursor).toEqual({ messageId: "m2", turnId: "new-1" });
  });

  it("段首帧不是 message_start：先留空，随后补盖 id，气泡不变", () => {
    const opened = plan(null, "");
    expect(opened.cursor).toEqual({ messageId: null, turnId: "new-1" });
    const backfilled = plan(opened.cursor, "m1");
    expect(backfilled.action).toBe("continue");
    expect(backfilled.cursor).toEqual({ messageId: "m1", turnId: "new-1" });
  });

  it("摆了续看姿势：首段认领既有气泡而不是另开（重连不双气泡）", () => {
    const p = plan(null, "m1", { adopt: "t-live" });
    expect(p.action).toBe("adopt");
    expect(p.cursor.turnId).toBe("t-live");
  });

  it("续看姿势只管首段：同一连接的下一个回合仍是新气泡", () => {
    const first = plan(null, "m1", { adopt: "t-live" });
    const second = planFollowSegment({
      cursor: first.cursor,
      messageId: "m2",
      adoptTurnId: "t-live", // 调用方还没来得及清也不许再认领
      turns: [],
      newTurnId: ids(),
    });
    expect(second.action).toBe("open");
    expect(second.cursor.turnId).toBe("new-1");
  });

  it("本端已折过但没收口（断线重连）→ 认领续折，不另开", () => {
    const turns: FoldedTurnLike[] = [
      { id: "t1", events: [start("m1"), delta] },
    ];
    const p = plan(null, "m1", { turns });
    expect(p.action).toBe("adopt");
    expect(p.cursor.turnId).toBe("t1");
  });

  it("本端已整段折完 → 静音丢弃多余重放（不双折、不双气泡）", () => {
    const turns: FoldedTurnLike[] = [
      { id: "t1", events: [start("m1"), delta, end] },
    ];
    const p = plan(null, "m1", { turns });
    expect(p.action).toBe("mute");
    expect(p.cursor).toEqual({ messageId: "m1", turnId: null });
  });

  it("静音段的后续帧继续丢弃，直到下一个 message_id 才恢复", () => {
    const muted = { messageId: "m1", turnId: null };
    expect(plan(muted, "").cursor.turnId).toBeNull();
    const next = plan(muted, "m2");
    expect(next.action).toBe("open");
    expect(next.cursor.turnId).toBe("new-1");
  });

  it("已折完的是别的回合时不误伤：新回合照常开", () => {
    const turns: FoldedTurnLike[] = [
      { id: "t1", events: [start("m1"), delta, end] },
    ];
    const p = plan(null, "m2", { turns });
    expect(p.action).toBe("open");
    expect(p.cursor.turnId).toBe("new-1");
  });
});
