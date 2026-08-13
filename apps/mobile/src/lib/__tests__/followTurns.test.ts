import {
  type FoldedTurnLike,
  type SegmentHead,
  planFollowIdle,
  planFollowSegment,
  readSegmentHead,
  turnMessageId,
} from "@/lib/followTurns";
import { describe, expect, it } from "vitest";

const start = (id: string) => ({
  type: "message_start",
  payload: { message_id: id },
});
const delta = { type: "content_delta", payload: { text: "hi" } };
const end = { type: "message_end", payload: {} };

/** 重放段的段首：服务端明令「先重置这个回合，再折这一段」。 */
const replayHead = (messageId: string): SegmentHead => ({
  messageId,
  fullReplay: true,
});
/** 直播段的段首（重放段为空时新回合的 message_start 落在边界之后）。 */
const liveHead = (messageId: string): SegmentHead => ({
  messageId,
  fullReplay: false,
});

/** 计数器代替 crypto.randomUUID，让「新开气泡」可断言。 */
function ids() {
  let n = 0;
  return () => `new-${++n}`;
}

function plan(
  cursor: Parameters<typeof planFollowSegment>[0]["cursor"],
  head: SegmentHead | null,
  opts: { adopt?: string | null; turns?: FoldedTurnLike[] } = {},
) {
  return planFollowSegment({
    cursor,
    head,
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

describe("readSegmentHead", () => {
  it("重放段段首带 full_replay 标记", () => {
    expect(
      readSegmentHead({
        type: "message_start",
        payload: { message_id: "m1", full_replay: true },
      }),
    ).toEqual({ messageId: "m1", fullReplay: true });
  });

  it("直播段段首没有标记", () => {
    expect(readSegmentHead(start("m1"))).toEqual({
      messageId: "m1",
      fullReplay: false,
    });
  });

  it("非 message_start 帧没有段首", () => {
    expect(readSegmentHead(delta)).toBeNull();
    expect(readSegmentHead(end)).toBeNull();
  });
});

describe("planFollowSegment", () => {
  it("空闲订阅上另一端起的回合 → 新开气泡", () => {
    const p = plan(null, replayHead("m1"));
    expect(p.action).toBe("open");
    expect(p.cursor).toEqual({ messageId: "m1", turnId: "new-1" });
  });

  it("同一回合的后续帧继续折进同一个气泡", () => {
    const cursor = { messageId: "m1", turnId: "t1" };
    const p = plan(cursor, null);
    expect(p.action).toBe("continue");
    expect(p.cursor.turnId).toBe("t1");
  });

  it("同一连接上的下一个回合 → 另开气泡（不复用上一段）", () => {
    const p = plan({ messageId: "m1", turnId: "t1" }, replayHead("m2"));
    expect(p.action).toBe("open");
    expect(p.cursor).toEqual({ messageId: "m2", turnId: "new-1" });
  });

  it("段首帧不是 message_start：先留空，随后补盖 id，气泡不变", () => {
    const opened = plan(null, null);
    expect(opened.cursor).toEqual({ messageId: null, turnId: "new-1" });
    const backfilled = plan(opened.cursor, liveHead("m1"));
    expect(backfilled.action).toBe("continue");
    expect(backfilled.cursor).toEqual({ messageId: "m1", turnId: "new-1" });
  });

  it("摆了续看姿势：首段认领既有气泡而不是另开（重连不双气泡）", () => {
    const p = plan(null, replayHead("m1"), { adopt: "t-live" });
    expect(p.action).toBe("reset");
    expect(p.cursor.turnId).toBe("t-live");
  });

  it("续看姿势只管首段：同一连接的下一个回合仍是新气泡", () => {
    const first = plan(null, replayHead("m1"), { adopt: "t-live" });
    const second = planFollowSegment({
      cursor: first.cursor,
      head: replayHead("m2"),
      adoptTurnId: "t-live", // 调用方还没来得及清也不许再认领
      turns: [],
      newTurnId: ids(),
    });
    expect(second.action).toBe("open");
    expect(second.cursor.turnId).toBe("new-1");
  });

  it("本端已折过但没收口（断线重连）→ 认领并重置，不另开", () => {
    const turns: FoldedTurnLike[] = [
      { id: "t1", events: [start("m1"), delta] },
    ];
    const p = plan(null, replayHead("m1"), { turns });
    expect(p.action).toBe("reset");
    expect(p.cursor.turnId).toBe("t1");
  });

  it("本端已整段折完：服务端仍明令重放 → 清空重折，不静音丢弃", () => {
    const turns: FoldedTurnLike[] = [
      { id: "t1", events: [start("m1"), delta, end] },
    ];
    const p = plan(null, replayHead("m1"), { turns });
    expect(p.action).toBe("reset");
    expect(p.cursor).toEqual({ messageId: "m1", turnId: "t1" });
  });

  it("同一连接上同 id 再来一段全量重放（挂起恢复重开）→ 重置，不当续帧", () => {
    const cursor = { messageId: "m1", turnId: "t1" };
    const p = plan(cursor, replayHead("m1"));
    expect(p.action).toBe("reset");
    expect(p.cursor).toEqual({ messageId: "m1", turnId: "t1" });
  });

  it("不带标记的直播段首落在既有气泡上 → 续折，不清", () => {
    const turns: FoldedTurnLike[] = [
      { id: "t1", events: [start("m1"), delta] },
    ];
    const p = plan(null, liveHead("m1"), { turns });
    expect(p.action).toBe("adopt");
    expect(p.cursor.turnId).toBe("t1");
  });

  it("已折完的是别的回合时不误伤：新回合照常开", () => {
    const turns: FoldedTurnLike[] = [
      { id: "t1", events: [start("m1"), delta, end] },
    ];
    const p = plan(null, replayHead("m2"), { turns });
    expect(p.action).toBe("open");
    expect(p.cursor.turnId).toBe("new-1");
  });
});

describe("planFollowIdle", () => {
  const idle = (over: Partial<Parameters<typeof planFollowIdle>[0]> = {}) =>
    planFollowIdle({
      expectLiveRun: false,
      adoptTurnId: null,
      reconnected: false,
      localStreamActive: false,
      ...over,
    });

  it("停在空闲对话上是常态：什么都不动", () => {
    expect(idle()).toEqual({ kind: "none" });
  });

  it("本端在等的回合已在连上之前收口 → 撤空转气泡 + 回读终稿", () => {
    expect(idle({ expectLiveRun: true, adoptTurnId: "t-live" })).toEqual({
      kind: "settle",
      staleTurnId: "t-live",
    });
  });

  it("重连挂上却空闲 → 补一次消息窗对账（断线期间另一端跑完的回合只在 REST 窗里）", () => {
    expect(idle({ reconnected: true })).toEqual({ kind: "reconcile" });
  });

  it("对账只补一次的判据是「这条订阅是重连挂的」，首连不补", () => {
    expect(idle({ reconnected: false })).toEqual({ kind: "none" });
  });

  it("本端自发流持有主时间线时不插手（整窗回读会和它折的回合打架）", () => {
    expect(idle({ reconnected: true, localStreamActive: true })).toEqual({
      kind: "none",
    });
  });

  it("还在等回合时以续看收口为准，不降级成纯对账", () => {
    expect(idle({ expectLiveRun: true, reconnected: true })).toEqual({
      kind: "settle",
      staleTurnId: null,
    });
  });
});
