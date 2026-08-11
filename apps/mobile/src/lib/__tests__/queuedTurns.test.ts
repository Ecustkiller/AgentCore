import { afterEach, describe, expect, it } from "vitest";
import {
  __resetQueuedTurnsForTests,
  applyQueuedTurnsSnapshot,
  clearQueuedTurns,
  listQueuedTurns,
  removeQueuedTurn,
  replaceQueuedTurns,
  upsertQueuedTurn,
} from "../queuedTurns";
import {
  QUEUE_DROPPED_HINT,
  reconcileQueuedTurns,
} from "../reconcileQueuedTurns";

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

describe("queuedTurns reconcile snapshot", () => {
  it("对账替换本地态：内容/顺序/深度以服务端为准", () => {
    upsertQueuedTurn({
      queueId: "q1",
      conversationId: "c1",
      content: "stale",
      position: 1,
      queueDepth: 1,
    });

    const { droppedLocalIds } = applyQueuedTurnsSnapshot("c1", [
      {
        queueId: "q2",
        content: "from server",
        position: 1,
        interjectionId: null,
      },
      {
        queueId: "q3",
        content: "also server",
        position: 2,
      },
    ]);

    expect(droppedLocalIds).toEqual(["q1"]);
    const list = listQueuedTurns("c1");
    expect(list.map((e) => e.queueId)).toEqual(["q2", "q3"]);
    expect(list[0]).toMatchObject({
      content: "from server",
      position: 1,
      queueDepth: 2,
    });
    expect(list[1]?.queueDepth).toBe(2);
  });

  it("插话来源项：interjectionId 映射进条", () => {
    applyQueuedTurnsSnapshot("c1", [
      {
        queueId: "q-inj",
        content: "promoted from steer",
        position: 1,
        interjectionId: "inj-42",
      },
    ]);
    const list = listQueuedTurns("c1");
    expect(list).toHaveLength(1);
    expect(list[0]?.interjectionId).toBe("inj-42");
  });

  it("服务端已空：清掉本地幽灵项并回报 droppedLocalIds", () => {
    upsertQueuedTurn({
      queueId: "ghost-1",
      conversationId: "c1",
      content: "was queued",
      position: 1,
      queueDepth: 2,
    });
    upsertQueuedTurn({
      queueId: "ghost-2",
      conversationId: "c1",
      content: "also gone",
      position: 2,
      queueDepth: 2,
    });

    const { droppedLocalIds } = applyQueuedTurnsSnapshot("c1", []);
    expect(droppedLocalIds).toEqual(["ghost-1", "ghost-2"]);
    expect(listQueuedTurns("c1")).toEqual([]);
  });

  it("同 queue_id 对账保留本地 degradedFrom", () => {
    upsertQueuedTurn({
      queueId: "q1",
      conversationId: "c1",
      content: "old",
      position: 1,
      queueDepth: 1,
      degradedFrom: "steer",
    });
    applyQueuedTurnsSnapshot("c1", [
      { queueId: "q1", content: "fresh", position: 1 },
    ]);
    expect(listQueuedTurns("c1")[0]).toMatchObject({
      content: "fresh",
      degradedFrom: "steer",
    });
  });

  it("replaceQueuedTurns 整表写入", () => {
    replaceQueuedTurns("c1", [
      {
        queueId: "a",
        conversationId: "c1",
        content: "x",
        position: 2,
        queueDepth: 2,
      },
      {
        queueId: "b",
        conversationId: "c1",
        content: "y",
        position: 1,
        queueDepth: 2,
      },
    ]);
    expect(listQueuedTurns("c1").map((e) => e.queueId)).toEqual(["b", "a"]);
  });
});

describe("reconcileQueuedTurns", () => {
  it("拉取快照后替换本地；服务端空 → dropped + 提示文案常量", async () => {
    upsertQueuedTurn({
      queueId: "local-only",
      conversationId: "c1",
      content: "ghost",
      position: 1,
      queueDepth: 1,
    });
    const result = await reconcileQueuedTurns("c1", async () => []);
    expect(result.failed).toBeUndefined();
    expect(result.droppedLocalIds).toEqual(["local-only"]);
    expect(listQueuedTurns("c1")).toEqual([]);
    expect(QUEUE_DROPPED_HINT).toMatch(/排队项已失效/);
  });

  it("fetch 失败不改本地", async () => {
    upsertQueuedTurn({
      queueId: "keep",
      conversationId: "c1",
      content: "still here",
      position: 1,
      queueDepth: 1,
    });
    const result = await reconcileQueuedTurns("c1", async () => {
      throw new Error("network");
    });
    expect(result.failed).toBe(true);
    expect(result.droppedLocalIds).toEqual([]);
    expect(listQueuedTurns("c1").map((e) => e.queueId)).toEqual(["keep"]);
  });

  it("对账写入插话升格项", async () => {
    const result = await reconcileQueuedTurns("c1", async () => [
      {
        queueId: "q-p",
        content: "from interjection",
        position: 1,
        interjectionId: "inj-9",
      },
    ]);
    expect(result.droppedLocalIds).toEqual([]);
    expect(listQueuedTurns("c1")[0]?.interjectionId).toBe("inj-9");
  });
});
