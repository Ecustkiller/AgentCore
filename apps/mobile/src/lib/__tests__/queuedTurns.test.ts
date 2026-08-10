import { afterEach, describe, expect, it } from "vitest";
import {
  __resetQueuedTurnsForTests,
  clearQueuedTurns,
  listQueuedTurns,
  removeQueuedTurn,
  upsertQueuedTurn,
} from "../queuedTurns";

afterEach(() => {
  __resetQueuedTurnsForTests();
});

describe("queuedTurns store", () => {
  it("多项按 position 排序，同 queueId upsert 不丢其它项", () => {
    upsertQueuedTurn({
      queueId: "q1",
      conversationId: "c1",
      content: "a",
      position: 1,
      queueDepth: 2,
    });
    upsertQueuedTurn({
      queueId: "q2",
      conversationId: "c1",
      content: "b",
      position: 2,
      queueDepth: 2,
    });
    upsertQueuedTurn({
      queueId: "q1",
      conversationId: "c1",
      content: "a",
      position: 1,
      queueDepth: 3,
    });

    const list = listQueuedTurns("c1");
    expect(list.map((e) => e.queueId)).toEqual(["q1", "q2"]);
    expect(list[0]?.queueDepth).toBe(3);
  });

  it("remove 按 queue_id 只清一项", () => {
    upsertQueuedTurn({
      queueId: "q1",
      conversationId: "c1",
      content: "a",
      position: 1,
      queueDepth: 2,
    });
    upsertQueuedTurn({
      queueId: "q2",
      conversationId: "c1",
      content: "b",
      position: 2,
      queueDepth: 2,
    });
    const hit = removeQueuedTurn("c1", "q1");
    expect(hit?.queueId).toBe("q1");
    expect(listQueuedTurns("c1").map((e) => e.queueId)).toEqual(["q2"]);
  });

  it("turn_queue_started 语义：remove 只清条（出队后再进主时间线用户泡）", () => {
    upsertQueuedTurn({
      queueId: "q-go",
      conversationId: "c1",
      content: "queued then start",
      position: 1,
      queueDepth: 1,
    });
    const hit = removeQueuedTurn("c1", "q-go");
    expect(hit?.content).toBe("queued then start");
    expect(listQueuedTurns("c1")).toEqual([]);
  });

  it("cancel 语义：remove 只清条（排队期无主时间线用户泡可删）", () => {
    upsertQueuedTurn({
      queueId: "q-x",
      conversationId: "c1",
      content: "cancel me",
      position: 1,
      queueDepth: 1,
    });
    removeQueuedTurn("c1", "q-x");
    expect(listQueuedTurns("c1")).toEqual([]);
  });

  it("clearConversation 清空该对话", () => {
    upsertQueuedTurn({
      queueId: "q1",
      conversationId: "c1",
      content: "a",
      position: 1,
      queueDepth: 1,
    });
    upsertQueuedTurn({
      queueId: "q9",
      conversationId: "c2",
      content: "x",
      position: 1,
      queueDepth: 1,
    });
    clearQueuedTurns("c1");
    expect(listQueuedTurns("c1")).toEqual([]);
    expect(listQueuedTurns("c2")).toHaveLength(1);
  });
});
