import { StreamError } from "@/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离断言 sendTurn / runResume「探活 → 路由 / 降级收敛」这一段的可观察契约：
// sendTurn——探活 ok 走 sidecar、首探失败(probed)走云+提示一次、bad 缓存命中(!probed)静默走云、
// 回合启动期失败(recoverable)降级并标坏、中途失败(!recoverable)不自动降级；
// runResume——探活 ok 走 sidecar 续跑、探活失败保留续跑卡 + 出横幅、绝不降级走云（本机帧云端没有）。
// 协作者全 mock；conversation / pausedTurn store 用真实，使 stillOptimistic / 截断 / 帧认领忠实。
vi.mock("@/hooks/useConversations", () => ({
  getConversations: vi.fn(() => []),
  bumpConversationCache: vi.fn(),
  restoreConversationCache: vi.fn(),
}));
vi.mock("@/services/sidecarRouting", () => ({
  resolveSidecarRoot: vi.fn(),
  buildSidecarHistory: vi.fn(() => []),
}));
vi.mock("@/services/sidecarHealth", () => ({
  probeSidecar: vi.fn(),
  markSidecarUnhealthy: vi.fn(),
  clearSidecarHealth: vi.fn(),
}));
vi.mock("@/services/streamConversation", () => ({
  attachConversation: vi.fn(),
  regenerateConversation: vi.fn(),
  resumeConversation: vi.fn(),
  streamConversation: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/streamConversationViaSidecar", () => ({
  resumeConversationViaSidecar: vi.fn(),
  streamConversationViaSidecar: vi.fn(),
}));
vi.mock("@/services/messages", () => ({ loadLatestWindow: vi.fn() }));
vi.mock("@/lib/toast", () => ({ notifyInfo: vi.fn() }));

import { notifyInfo } from "@/lib/toast";
import {
  clearSidecarHealth,
  markSidecarUnhealthy,
  probeSidecar,
} from "@/services/sidecarHealth";
import { resolveSidecarRoot } from "@/services/sidecarRouting";
import {
  resumeConversation,
  streamConversation,
} from "@/services/streamConversation";
import {
  resumeConversationViaSidecar,
  streamConversationViaSidecar,
} from "@/services/streamConversationViaSidecar";
import { useConversationStore } from "@/stores/conversation";
import { type PendingResume, usePausedTurnStore } from "@/stores/pausedTurns";
import { runResume, sendTurn } from "../turns";

const resolveSidecarRootMock = vi.mocked(resolveSidecarRoot);
const probeSidecarMock = vi.mocked(probeSidecar);
const markSidecarUnhealthyMock = vi.mocked(markSidecarUnhealthy);
const clearSidecarHealthMock = vi.mocked(clearSidecarHealth);
const streamConversationMock = vi.mocked(streamConversation);
const streamViaSidecarMock = vi.mocked(streamConversationViaSidecar);
const resumeConversationMock = vi.mocked(resumeConversation);
const resumeViaSidecarMock = vi.mocked(resumeConversationViaSidecar);
const notifyInfoMock = vi.mocked(notifyInfo);

const TARGET = { rootId: "r1", subpath: "" };

function spec() {
  return {
    conversationId: "c1",
    content: "hi",
    attachments: [],
    optimisticUserId: "opt1",
  };
}

/** Seed the optimistic user bubble sendTurn expects: stillOptimistic = true → a
 *  fresh attempt (not regenerate-from-persisted). */
function seedOptimisticUser(): void {
  useConversationStore.getState().addMessage(
    {
      id: "opt1",
      role: "user",
      content: "hi",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    },
    "c1",
  );
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  usePausedTurnStore.setState({ pending: [] });
  vi.clearAllMocks();
  streamConversationMock.mockResolvedValue(undefined);
  seedOptimisticUser();
});

afterEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  usePausedTurnStore.setState({ pending: [] });
});

describe("sendTurn — 探活路由 / 降级收敛（探活增强）", () => {
  it("探活通过 → 走本地 sidecar，不碰云链路", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    probeSidecarMock.mockResolvedValue({
      healthy: true,
      probed: true,
      detail: null,
    });
    streamViaSidecarMock.mockResolvedValue(undefined as never);

    await sendTurn(spec());

    expect(probeSidecarMock).toHaveBeenCalledTimes(1);
    expect(streamViaSidecarMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", rootId: "r1" }),
    );
    expect(streamConversationMock).not.toHaveBeenCalled();
  });

  it("探活失败 → 提示一次（带诊断）并走云，不走 sidecar", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    probeSidecarMock.mockResolvedValue({
      healthy: false,
      probed: true,
      detail: "本地引擎启动失败：spawn uv ENOENT",
    });

    await sendTurn(spec());

    expect(notifyInfoMock).toHaveBeenCalledTimes(1);
    expect(String(notifyInfoMock.mock.calls[0][0])).toContain(
      "spawn uv ENOENT",
    );
    expect(streamConversationMock).toHaveBeenCalledTimes(1);
    expect(streamViaSidecarMock).not.toHaveBeenCalled();
  });

  it("探活通过但回合启动期失败(recoverable) → 标坏 + 降级走云", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    probeSidecarMock.mockResolvedValue({
      healthy: true,
      probed: true,
      detail: null,
    });
    streamViaSidecarMock.mockRejectedValue(
      new StreamError("sidecar", undefined, {
        serverMessage: "拉不起",
        recoverable: true,
      }),
    );

    await sendTurn(spec());

    expect(markSidecarUnhealthyMock).toHaveBeenCalledWith(TARGET);
    expect(streamConversationMock).toHaveBeenCalledTimes(1); // 降级走云
  });

  it("中途失败(!recoverable) → 不自动降级、不标坏（照常出横幅）", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    probeSidecarMock.mockResolvedValue({
      healthy: true,
      probed: true,
      detail: null,
    });
    streamViaSidecarMock.mockRejectedValue(
      new StreamError("sidecar", undefined, {
        serverMessage: "中途崩",
        recoverable: false,
      }),
    );

    await sendTurn(spec());

    expect(markSidecarUnhealthyMock).not.toHaveBeenCalled();
    expect(streamConversationMock).not.toHaveBeenCalled();
  });

  it("bad 缓存命中(!probed) → 静默走云、不再提示", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    // 该根本会话已探明坏：probeSidecar 命中缓存（probed:false），不该再 notifyInfo。
    probeSidecarMock.mockResolvedValue({
      healthy: false,
      probed: false,
      detail: null,
    });

    await sendTurn(spec());

    expect(streamConversationMock).toHaveBeenCalledTimes(1); // 静默走云
    expect(streamViaSidecarMock).not.toHaveBeenCalled();
    expect(notifyInfoMock).not.toHaveBeenCalled(); // 不再打扰
  });
});

/** 构造一个 sidecar 暂停帧（plan_review），续跑测试用：字段齐全、内容最小。 */
function pendingFrame(messageId: string, conversationId = "c1"): PendingResume {
  return {
    messageId,
    conversationId,
    checkpointId: "ck1",
    kind: "plan_review",
    userMessage: "原始请求",
    steps: [],
    pending: [],
    question: "",
    context: "",
    assumptions: [],
    questions: [],
    styleOptions: [],
  };
}

describe("runResume — 续跑探活（不降级、本机帧只在本地）", () => {
  beforeEach(() => {
    useConversationStore.setState({ currentConversationId: "c1", byId: {} });
    usePausedTurnStore.setState({ pending: [pendingFrame("m1")] });
  });

  it("探活通过 → 本地 sidecar 续跑、认领续跑卡", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    probeSidecarMock.mockResolvedValue({
      healthy: true,
      probed: true,
      detail: null,
    });
    resumeViaSidecarMock.mockResolvedValue(undefined as never);

    await runResume("m1", "continue", "");

    expect(resumeViaSidecarMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1", rootId: "r1" }),
    );
    expect(resumeConversationMock).not.toHaveBeenCalled();
    expect(usePausedTurnStore.getState().pending).toHaveLength(0); // 帧已认领
  });

  it("探活失败 → 保留续跑卡 + 出横幅，绝不降级走云", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    probeSidecarMock.mockResolvedValue({
      healthy: false,
      probed: true,
      detail: "venv 损坏",
    });

    await runResume("m1", "continue", "");

    expect(resumeViaSidecarMock).not.toHaveBeenCalled();
    expect(resumeConversationMock).not.toHaveBeenCalled(); // 不降级走云（云端没这帧）
    expect(usePausedTurnStore.getState().pending).toHaveLength(1); // 续跑卡保留
    expect(useConversationStore.getState().byId.c1?.error).toContain(
      "venv 损坏",
    );
  });

  it("会话未绑本地根（云端续跑）→ 不探活、直接走云 resume", async () => {
    resolveSidecarRootMock.mockResolvedValue(null);

    await runResume("m1", "continue", "");

    expect(probeSidecarMock).not.toHaveBeenCalled();
    expect(resumeConversationMock).toHaveBeenCalledTimes(1);
    expect(resumeViaSidecarMock).not.toHaveBeenCalled();
    expect(usePausedTurnStore.getState().pending).toHaveLength(0); // 云端续跑照常认领
  });

  it("探活失败横幅的「重试」清缓存强制重探（非死按钮）", async () => {
    resolveSidecarRootMock.mockResolvedValue(TARGET);
    probeSidecarMock.mockResolvedValue({
      healthy: false,
      probed: true,
      detail: null,
    });

    await runResume("m1", "continue", "");
    expect(probeSidecarMock).toHaveBeenCalledTimes(1);

    const retry = useConversationStore.getState().byId.c1?.retry;
    expect(retry).toBeTypeOf("function");
    retry?.(); // 用户点「重试」
    expect(clearSidecarHealthMock).toHaveBeenCalledTimes(1); // 同步先清缓存

    // 清缓存后重试会真重探（生产里 clearSidecarHealth 清 map → probeSidecar 不再命中 bad）。
    await vi.waitFor(() => expect(probeSidecarMock).toHaveBeenCalledTimes(2));
    expect(usePausedTurnStore.getState().pending).toHaveLength(1); // 仍未续成功 → 帧保留
  });
});
