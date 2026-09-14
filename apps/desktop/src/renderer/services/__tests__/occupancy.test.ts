/**
 * @vitest-environment jsdom
 */
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGeneratingWhenSidecarIdle,
  probeSidecarLiveness,
  querySidecarOccupancy,
} from "../turns/occupancy";

afterEach(() => {
  vi.unstubAllGlobals();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

describe("querySidecarOccupancy", () => {
  it("空 id / 无 API → 不当成占着", async () => {
    vi.stubGlobal("window", {});
    expect(await querySidecarOccupancy("")).toEqual({ occupied: false });
    expect(await querySidecarOccupancy("c1")).toEqual({ occupied: false });
  });

  it("IPC 抛错 → unknown（发送门不当闲）", async () => {
    vi.stubGlobal("window", {
      sidecarApi: {
        occupancy: vi.fn(async () => {
          throw new Error("ipc down");
        }),
      },
    });
    expect(await querySidecarOccupancy("c1")).toEqual({
      occupied: false,
      unknown: true,
    });
  });

  it("把主进程活表原样交出发送门", async () => {
    const occupancy = vi.fn(async () => ({
      occupied: true,
      rootId: "r1",
      subpath: "conversations/c1",
    }));
    vi.stubGlobal("window", { sidecarApi: { occupancy } });
    expect(await querySidecarOccupancy("c1")).toEqual({
      occupied: true,
      rootId: "r1",
      subpath: "conversations/c1",
    });
    expect(occupancy).toHaveBeenCalledWith({ conversationId: "c1" });
  });
});

describe("probeSidecarLiveness", () => {
  it("空 id / 无 API → unknown（关灯失败不当闲）", async () => {
    vi.stubGlobal("window", {});
    expect(await probeSidecarLiveness("")).toBe("unknown");
    expect(await probeSidecarLiveness("c1")).toBe("unknown");
  });

  it("IPC 抛错 → unknown", async () => {
    vi.stubGlobal("window", {
      sidecarApi: {
        occupancy: vi.fn(async () => {
          throw new Error("ipc down");
        }),
      },
    });
    expect(await probeSidecarLiveness("c1")).toBe("unknown");
  });

  it("occupied true / false 映射 occupied / idle", async () => {
    const occupancy = vi.fn(async () => ({ occupied: true }));
    vi.stubGlobal("window", { sidecarApi: { occupancy } });
    expect(await probeSidecarLiveness("c1")).toBe("occupied");
    occupancy.mockResolvedValueOnce({ occupied: false });
    expect(await probeSidecarLiveness("c1")).toBe("idle");
  });
});

describe("clearGeneratingWhenSidecarIdle", () => {
  const CID = "c-idle";

  beforeEach(() => {
    useConversationStore.setState({ currentConversationId: null, byId: {} });
    useConversationStore.getState().switchConversation(CID);
    useConversationStore.getState().setGenerating(true, CID);
  });

  it("idle → 关灯", async () => {
    vi.stubGlobal("window", {
      sidecarApi: { occupancy: vi.fn(async () => ({ occupied: false })) },
    });
    await clearGeneratingWhenSidecarIdle(CID);
    expect(getRuntime(CID).isGenerating).toBe(false);
  });

  it("occupied → 不关", async () => {
    vi.stubGlobal("window", {
      sidecarApi: { occupancy: vi.fn(async () => ({ occupied: true })) },
    });
    await clearGeneratingWhenSidecarIdle(CID);
    expect(getRuntime(CID).isGenerating).toBe(true);
  });

  it("IPC 抛错 → 不关", async () => {
    vi.stubGlobal("window", {
      sidecarApi: {
        occupancy: vi.fn(async () => {
          throw new Error("ipc down");
        }),
      },
    });
    await clearGeneratingWhenSidecarIdle(CID);
    expect(getRuntime(CID).isGenerating).toBe(true);
  });

  it("skip 在问完活表后仍成立 → 不关", async () => {
    vi.stubGlobal("window", {
      sidecarApi: { occupancy: vi.fn(async () => ({ occupied: false })) },
    });
    await clearGeneratingWhenSidecarIdle(CID, { skip: () => true });
    expect(getRuntime(CID).isGenerating).toBe(true);
  });
});
