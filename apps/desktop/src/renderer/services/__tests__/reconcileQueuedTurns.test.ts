import { notifyInfo } from "@/lib/toast";
import { api } from "@/services/api";
import {
  reconcileQueuedTurns,
  resetReconcileQueuedTurnsInflightForTests,
} from "@/services/turns/reconcileQueuedTurns";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn() },
  };
});

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const get = vi.mocked(api.get);
const notifyInfoMock = vi.mocked(notifyInfo);
const CID = "conv-reconcile-q";

beforeEach(() => {
  get.mockReset();
  notifyInfoMock.mockReset();
  resetReconcileQueuedTurnsInflightForTests();
  useQueuedTurnsStore.setState({ byConversation: {} });
});

describe("reconcileQueuedTurns", () => {
  it("用服务端快照替换本地态（含插话升队项）", async () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "stale",
      conversationId: CID,
      content: "本地旧项",
      position: 1,
      queueDepth: 1,
    });
    get.mockResolvedValue({
      items: [
        {
          queue_id: "q-ij",
          content: "升格后的插话",
          position: 1,
          interjection_id: "ij-1",
        },
        {
          queue_id: "q-plain",
          content: "普通排队",
          position: 2,
        },
      ],
    });

    await reconcileQueuedTurns(CID);

    expect(get).toHaveBeenCalledWith(`/v1/conversations/${CID}/queued-turns`);
    const list = useQueuedTurnsStore.getState().list(CID);
    expect(list.map((e) => e.queueId)).toEqual(["q-ij", "q-plain"]);
    expect(list[0]).toMatchObject({
      content: "升格后的插话",
      interjectionId: "ij-1",
      position: 1,
      queueDepth: 2,
    });
    expect(list[1]?.interjectionId).toBeUndefined();
    // 本地有项服务端已无 → 轻提示
    expect(notifyInfoMock).toHaveBeenCalledWith(
      "排队已失效：服务重启后队列不会保留",
    );
  });

  it("服务端已空：提示一次并清掉幽灵条", async () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "ghost",
      conversationId: CID,
      content: "重启前排队",
      position: 1,
      queueDepth: 1,
    });
    get.mockResolvedValue({ items: [] });

    await reconcileQueuedTurns(CID);

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([]);
    expect(notifyInfoMock).toHaveBeenCalledTimes(1);
    expect(notifyInfoMock).toHaveBeenCalledWith(
      "排队已失效：服务重启后队列不会保留",
    );
  });

  it("本地已空且服务端有项：静默写入、不提示", async () => {
    get.mockResolvedValue({
      items: [
        {
          queue_id: "q1",
          content: "他端排队",
          position: 1,
        },
      ],
    });

    await reconcileQueuedTurns(CID);

    expect(useQueuedTurnsStore.getState().list(CID)).toEqual([
      expect.objectContaining({
        queueId: "q1",
        content: "他端排队",
        queueDepth: 1,
      }),
    ]);
    expect(notifyInfoMock).not.toHaveBeenCalled();
  });

  it("GET 失败不改本地、不抛", async () => {
    useQueuedTurnsStore.getState().upsert({
      queueId: "keep",
      conversationId: CID,
      content: "保留",
      position: 1,
      queueDepth: 1,
    });
    get.mockRejectedValue(new Error("network"));

    await expect(reconcileQueuedTurns(CID)).resolves.toBeUndefined();
    expect(useQueuedTurnsStore.getState().list(CID)).toHaveLength(1);
    expect(notifyInfoMock).not.toHaveBeenCalled();
  });
});
