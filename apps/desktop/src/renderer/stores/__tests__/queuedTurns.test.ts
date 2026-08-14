import {
  type QueuedTurnEntry,
  useQueuedTurnsStore,
} from "@/stores/queuedTurns";
import { afterEach, describe, expect, it } from "vitest";

function entry(
  conversationId: string,
  queueId: string,
  content = "x",
): QueuedTurnEntry {
  return {
    queueId,
    conversationId,
    content,
    position: 1,
    queueDepth: 1,
  };
}

afterEach(() => {
  useQueuedTurnsStore.setState({ byConversation: {} });
});

describe("queuedTurns replaceAll", () => {
  it("整表替换云队，keepKey 本机 key 保留", () => {
    const store = useQueuedTurnsStore.getState();
    store.replaceConversation("cloud-1", [entry("cloud-1", "q-stale")]);
    store.replaceConversation("local-1", [entry("local-1", "q-local")]);
    store.replaceAll(
      { "cloud-2": [entry("cloud-2", "q-new", "fresh")] },
      (id) => id === "local-1",
    );
    expect(store.list("cloud-1")).toEqual([]);
    expect(store.list("local-1")).toEqual([
      expect.objectContaining({ queueId: "q-local" }),
    ]);
    expect(store.list("cloud-2")).toEqual([
      expect.objectContaining({ queueId: "q-new", content: "fresh" }),
    ]);
  });

  it("空表只清云队", () => {
    const store = useQueuedTurnsStore.getState();
    store.replaceConversation("cloud-1", [entry("cloud-1", "q-stale")]);
    store.replaceConversation("local-1", [entry("local-1", "q-local")]);
    store.replaceAll({}, (id) => id === "local-1");
    expect(store.list("cloud-1")).toEqual([]);
    expect(store.list("local-1")).toHaveLength(1);
  });

  it("keepKey 为真的入站云条不覆盖本机", () => {
    const store = useQueuedTurnsStore.getState();
    store.replaceConversation("local-1", [entry("local-1", "q-local")]);
    store.replaceAll(
      { "local-1": [entry("local-1", "q-cloud", "nope")] },
      (id) => id === "local-1",
    );
    expect(store.list("local-1")).toEqual([
      expect.objectContaining({ queueId: "q-local" }),
    ]);
  });

  it("增量空 items 只清一条", () => {
    const store = useQueuedTurnsStore.getState();
    store.replaceConversation("c1", [entry("c1", "q1")]);
    store.replaceConversation("c2", [entry("c2", "q2")]);
    store.replaceConversation("c1", []);
    expect(store.list("c1")).toEqual([]);
    expect(store.list("c2")).toHaveLength(1);
  });
});
