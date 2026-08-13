import { StreamError } from "@/lib/errors";
import { notifyError } from "@/lib/toast";
import { captureCsrf, clearCsrfToken } from "@/services/api";
import { sendMidFlightMessage } from "@/services/turns/midFlight";
import { resetStreamOwnershipForTests } from "@/services/turns/streamOwnership";
import { useConversationStore } from "@/stores/conversation";
import { useQueuedTurnsStore } from "@/stores/queuedTurns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 插话 POST 也吃 CSRF 403 自愈（与 `api.request` / `authedFetch` 同一条判据）。
 * 缺这条时的形状：离线转在线后会话半武装，读请求全通、写请求全 403，用户点发送「没反应」。
 *
 * 「重发一条会插话 / 起回合的 POST」之所以不是隐患，全由 `isReplayableCsrfRejection`
 * 保证——它只在 middleware 前置拒绝、handler 从未执行、且服务端回发了新令牌时才为真，
 * 所以服务端从未受理过第一次发送，重发不会双开回合、不会重复插话。
 */

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}));

const notifyErrorMock = vi.mocked(notifyError);
const CID = "conv-mf-csrf";

/** 后端 middleware/csrf.py 的拒绝体，抵达客户端时的样子。 */
const CSRF_BODY = JSON.stringify({
  error: {
    code: "CSRF_FAILED",
    message: "CSRF token missing or invalid. Re-login and retry.",
  },
});

/** 一次被拒的插话；`reissued` = 这次拒绝随手回发的替换令牌。 */
function csrfRejection(reissued?: string): Response {
  return new Response(CSRF_BODY, {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      ...(reissued ? { "X-CSRF-Token": reissued } : {}),
    },
  });
}

/** 一条立即收口的插话确认流（重放成功后要真的被当流读完）。 */
function interjectionAck(): Response {
  const event = {
    type: "user_interjection",
    timestamp: "t",
    payload: {
      interjection_id: "ij-1",
      execution_id: "ex-1",
      content: "插一句",
      status: "received",
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * 按序回放脚本响应；`sentTokens` 记录每次发送实际带上的 `X-CSRF-Token`，长度即预算
 * 所约束的尝试次数。脚本用尽仍再发 = 重放成环，直接炸。
 */
function stubFetch(responses: Response[]): {
  sentTokens: (string | undefined)[];
} {
  const queue = [...responses];
  const sentTokens: (string | undefined)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sentTokens.push(headers["X-CSRF-Token"]);
      const next = queue.shift();
      if (!next) throw new Error(`第 ${sentTokens.length} 次发送：重放成环了`);
      return Promise.resolve(next);
    }),
  );
  return { sentTokens };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStreamOwnershipForTests();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useQueuedTurnsStore.setState({ byConversation: {} });
  useConversationStore.getState().switchConversation(CID);
  useConversationStore.getState().setTurnPhase("streaming", CID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStreamOwnershipForTests();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useQueuedTurnsStore.setState({ byConversation: {} });
  // 令牌活在 api 模块的内存里，跨用例会串。
  clearCsrfToken();
});

describe("sendMidFlightMessage (CSRF 403 自愈)", () => {
  it("可自愈的 403 重放一次，第二次带上服务端回发的新令牌", async () => {
    captureCsrf(
      new Response(null, { headers: { "X-CSRF-Token": "tok-stale" } }),
    );
    const { sentTokens } = stubFetch([
      csrfRejection("tok-reissued"),
      interjectionAck(),
    ]);

    await expect(
      sendMidFlightMessage(CID, "插一句", undefined, "steer"),
    ).resolves.toEqual({ kind: "received", interjectionId: "ij-1" });

    // doFetch 每次调用重算 header——重放靠这个才带得上刚换发的令牌。
    expect(sentTokens).toEqual(["tok-stale", "tok-reissued"]);
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it("没回发令牌的 403 只发一次，原样失败", async () => {
    // 无 header = 服务端刻意不重新武装（呈上的令牌签给了别的会话），重发只会以
    // *那个*会话的身份插话，所以必须保持失败。
    const { sentTokens } = stubFetch([csrfRejection()]);

    await expect(
      sendMidFlightMessage(CID, "插一句", undefined, "steer"),
    ).resolves.toEqual({ kind: "error" });

    expect(sentTokens).toHaveLength(1);
    const refusal = notifyErrorMock.mock.calls[0]?.[0];
    expect(refusal).toBeInstanceOf(StreamError);
    expect((refusal as StreamError).status).toBe(403);
    expect((refusal as StreamError).code).toBe("CSRF_FAILED");
  });
});
