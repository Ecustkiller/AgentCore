import {
  StreamError,
  describeStreamError,
  errorActionForCode,
  isRetriableStreamError,
  streamErrorAction,
} from "@/lib/errors";
import { useConversationStore } from "@/stores/conversation";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as dispatchMod from "../sse/dispatch";
import {
  ATTACH_CAUGHT_UP_COMMENT,
  attachConversation,
  forceSseTransportDrop,
  pumpSseBody,
  streamConversation,
} from "../streamConversation";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

describe("describeStreamError", () => {
  it("surfaces the backend's verbatim message for a 429 (quota reset / cool-down)", () => {
    const err = new StreamError("http", 429, {
      code: "QUOTA_EXCEEDED",
      serverMessage:
        "已达每日 token 上限（2,000,000 / 2,000,000），明日 0 点（UTC）重置。",
    });
    expect(describeStreamError(err)).toBe(
      "已达每日 token 上限（2,000,000 / 2,000,000），明日 0 点（UTC）重置。",
    );
  });

  it("falls back to a cool-down message for a 429 with only Retry-After", () => {
    const err = new StreamError("http", 429, {
      code: "RATE_LIMITED",
      retryAfter: 30,
    });
    expect(describeStreamError(err)).toBe("操作过于频繁，请约 30 秒后再试");
  });

  it("falls back to a generic 429 message when nothing rides along", () => {
    expect(describeStreamError(new StreamError("http", 429))).toBe(
      "操作过于频繁或额度已用尽，请稍后再试",
    );
  });

  it("surfaces the backend's actionable message for a 402 missing BYOK key", () => {
    const err = new StreamError("http", 402, {
      code: "LLM_KEY_REQUIRED",
      serverMessage:
        "请先在「设置 · 服务商」中填入你的 DeepSeek API Key，再发起对话。",
    });
    expect(describeStreamError(err)).toBe(
      "请先在「设置 · 服务商」中填入你的 DeepSeek API Key，再发起对话。",
    );
  });

  it("falls back to a config hint for a 402 with no server message", () => {
    const err = new StreamError("http", 402, { code: "LLM_KEY_REQUIRED" });
    expect(describeStreamError(err)).toContain("服务商");
    expect(describeStreamError(err)).not.toContain("服务暂时不可用");
  });

  it("phrases other http errors as a temporary outage", () => {
    expect(describeStreamError(new StreamError("http", 503))).toContain(
      "服务暂时不可用",
    );
  });

  it("maps turn_in_progress to an explicit zh wrap-up hint", () => {
    expect(
      describeStreamError(
        new StreamError("http", 409, { code: "turn_in_progress" }),
      ),
    ).toBe("回合收尾尚未完成，请稍候或先显式停止后再试");
    expect(
      describeStreamError(
        new StreamError("http", 409, {
          code: "turn_in_progress",
          serverMessage: "会话有正在进行的回合，先等它结束或显式停止",
        }),
      ),
    ).toBe("回合收尾尚未完成，请稍候或先显式停止后再试");
  });

  it("phrases network errors and stays silent on auth", () => {
    expect(describeStreamError(new StreamError("network"))).toContain("网络");
    expect(describeStreamError(new StreamError("auth"))).toBeNull();
  });

  it("maps CLIENT_TOO_OLD / 426 to force-update product copy", () => {
    expect(
      describeStreamError(
        new StreamError("http", 426, {
          code: "CLIENT_TOO_OLD",
          serverMessage: "upgrade required",
        }),
      ),
    ).toBe("桌面端版本过旧，请更新后再试");
    expect(describeStreamError(new StreamError("http", 426))).toBe(
      "桌面端版本过旧，请更新后再试",
    );
  });
});

describe("isRetriableStreamError", () => {
  it("does not offer retry for a quota refusal (resets on a schedule)", () => {
    const err = new StreamError("http", 429, { code: "QUOTA_EXCEEDED" });
    expect(isRetriableStreamError(err)).toBe(false);
  });

  it("does not offer retry for a missing BYOK key (needs configuration)", () => {
    const err = new StreamError("http", 402, { code: "LLM_KEY_REQUIRED" });
    expect(isRetriableStreamError(err)).toBe(false);
  });

  it("offers retry for rate-limit, transport, and unknown errors", () => {
    expect(
      isRetriableStreamError(
        new StreamError("http", 429, { code: "RATE_LIMITED" }),
      ),
    ).toBe(true);
    expect(isRetriableStreamError(new StreamError("network"))).toBe(true);
    expect(isRetriableStreamError(new Error("boom"))).toBe(true);
  });
});

describe("errorActionForCode", () => {
  it("routes missing and invalid keys to the providers page", () => {
    expect(errorActionForCode("LLM_KEY_REQUIRED")).toEqual({
      label: "去设置",
      href: "/more/providers",
    });
    expect(errorActionForCode("LLM_KEY_INVALID")).toEqual({
      label: "去设置",
      href: "/more/providers",
    });
  });

  it("routes FREE_TIER_EXHAUSTED as unknown code (no settings CTA)", () => {
    // FREE_TIER_EXHAUSTED retired with the free-tier path; leftover wire codes
    // fall through to null action (quota uses QUOTA_EXCEEDED).
    expect(errorActionForCode("FREE_TIER_EXHAUSTED")).toBeNull();
  });

  it("routes balance errors to settings; quota offers a BYOK secondary exit (F6)", () => {
    expect(errorActionForCode("LLM_INSUFFICIENT_BALANCE")).toEqual({
      label: "去设置",
      href: "/more/providers",
    });
    // 平台额度耗尽补次级 CTA「接入自己的 Key」(成本配额与计费 §〇·六 F6).
    expect(errorActionForCode("QUOTA_EXCEEDED")).toEqual({
      label: "接入自己的 Key",
      href: "/more/providers",
    });
    expect(errorActionForCode(undefined)).toBeNull();
  });

  it("streamErrorAction delegates to the code map for a StreamError", () => {
    expect(
      streamErrorAction(
        new StreamError("http", 402, { code: "LLM_KEY_REQUIRED" }),
      ),
    ).toEqual({ label: "去设置", href: "/more/providers" });
    expect(streamErrorAction(new Error("boom"))).toBeNull();
  });
});

describe("streamConversation (refused turn)", () => {
  it("parses a 429 JSON body + Retry-After header into a StreamError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "RATE_LIMITED",
                message: "操作过于频繁，请约 42 秒后再发送。",
              },
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "42",
              },
            },
          ),
        ),
      ),
    );

    const fetchMock = vi.mocked(fetch);
    const err = await streamConversation({
      conversationId: "c1",
      content: "hi",
      attachments: [],
      delivery: "steer",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StreamError);
    const streamErr = err as StreamError;
    expect(streamErr.status).toBe(429);
    expect(streamErr.code).toBe("RATE_LIMITED");
    expect(streamErr.serverMessage).toBe("操作过于频繁，请约 42 秒后再发送。");
    expect(streamErr.retryAfter).toBe(42);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({
        "X-Client-Platform": expect.any(String),
        "X-Client-Version": expect.any(String),
      }),
    );
  });
});

describe("attachConversation (实时重连续看 1b)", () => {
  it("returns 'none' on a 204 so the caller falls back to the persisted transcript", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
    useConversationStore.getState().switchConversation("c1");
    await expect(attachConversation("c1")).resolves.toBe("none");
  });

  it("targets the conversation's stream endpoint with a GET", async () => {
    const fetchMock = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    useConversationStore.getState().switchConversation("conv-42");
    await attachConversation("conv-42");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/conversations/conv-42/stream");
    // 回合级语义：绝不带 ``follow``——rejoinLiveTurn 的「无 live run → 读持久化」
    // 分支就靠这个 204（对话级长订阅走 turns/conversationFollow）。
    expect(url).not.toContain("follow");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "X-Client-Platform": expect.any(String),
        "X-Client-Version": expect.any(String),
      }),
    );
  });

  it("raises a StreamError when the attach is refused (e.g. not owned → 404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    useConversationStore.getState().switchConversation("c1");
    const err = await attachConversation("c1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).status).toBe(404);
  });

  it("buffers replay until attach-caught-up, then delivers live events", async () => {
    const seen: string[] = [];
    vi.spyOn(dispatchMod, "dispatchSSEEvent").mockImplementation((event) => {
      seen.push(event.type);
      if (event.type === "message_end") {
        useConversationStore.getState().setGenerating(false, "c1");
      }
    });
    vi.spyOn(dispatchMod, "flushPendingContent").mockImplementation(() => {});
    vi.spyOn(dispatchMod, "flushPendingFrames").mockImplementation(() => {});

    const body = [
      'data: {"type":"run_started","timestamp":"t","payload":{"run_id":"w1","agent_id":"a","kind":"agent"}}\n\n',
      'data: {"type":"run_completed","timestamp":"t","payload":{"run_id":"w1","agent_id":"a"}}\n\n',
      `: ${ATTACH_CAUGHT_UP_COMMENT}\n\n`,
      'data: {"type":"run_output_delta","timestamp":"t","payload":{"run_id":"w2","agent_id":"b","delta":"x"}}\n\n',
      'data: {"type":"message_end","timestamp":"t","payload":{"finish_reason":"end_turn"}}\n\n',
    ].join("");

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      ),
    );
    useConversationStore.getState().switchConversation("c1");
    useConversationStore.getState().createAssistantMessage("c1");

    await expect(attachConversation("c1")).resolves.toBe("attached");
    expect(seen).toEqual([
      "run_started",
      "run_completed",
      "run_output_delta",
      "message_end",
    ]);
  });
});

describe("pumpSseBody comments", () => {
  it("surfaces attach-caught-up (and ignores unknown comment text shape)", async () => {
    const events: string[] = [];
    const comments: string[] = [];
    const body = [
      'data: {"type":"content_delta","timestamp":"t","payload":{"delta":"a"}}\n\n',
      ": ping\n\n",
      `: ${ATTACH_CAUGHT_UP_COMMENT}\n\n`,
      'data: {"type":"content_delta","timestamp":"t","payload":{"delta":"b"}}\n\n',
    ].join("");
    await pumpSseBody(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      "c1",
      (e) => events.push(e.type),
      (c) => comments.push(c),
    );
    expect(events).toEqual(["content_delta", "content_delta"]);
    expect(comments).toEqual(["ping", ATTACH_CAUGHT_UP_COMMENT]);
  });

  it("forceSseTransportDrop rejects the active pump as StreamError network", async () => {
    let pull!: (chunk: Uint8Array | null) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        pull = (chunk) => {
          if (chunk == null) controller.close();
          else controller.enqueue(chunk);
        };
      },
    });
    const pumped = pumpSseBody(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      "force-drop-cid",
      () => {},
    );
    // Let the first readChunk park on reader.read().
    await Promise.resolve();
    expect(forceSseTransportDrop("force-drop-cid")).toBe(true);
    await expect(pumped).rejects.toMatchObject({
      name: "StreamError",
      kind: "network",
    });
    expect(forceSseTransportDrop("force-drop-cid")).toBe(false);
    // Avoid hanging the ReadableStream if anything still holds it.
    try {
      pull(null);
    } catch {
      /* already cancelled */
    }
  });
});
