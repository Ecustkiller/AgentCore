import {
  StreamError,
  describeStreamError,
  errorActionForCode,
  isRetriableStreamError,
  streamErrorAction,
} from "@/lib/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamConversation } from "../streamConversation";

afterEach(() => {
  vi.unstubAllGlobals();
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
        "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再发起对话。",
    });
    expect(describeStreamError(err)).toBe(
      "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再发起对话。",
    );
  });

  it("falls back to a config hint for a 402 with no server message", () => {
    const err = new StreamError("http", 402, { code: "LLM_KEY_REQUIRED" });
    expect(describeStreamError(err)).toContain("模型配置");
    expect(describeStreamError(err)).not.toContain("服务暂时不可用");
  });

  it("phrases other http errors as a temporary outage", () => {
    expect(describeStreamError(new StreamError("http", 503))).toContain(
      "服务暂时不可用",
    );
  });

  it("phrases network errors and stays silent on auth", () => {
    expect(describeStreamError(new StreamError("network"))).toContain("网络");
    expect(describeStreamError(new StreamError("auth"))).toBeNull();
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
  it("routes missing and invalid keys to the model-config page", () => {
    expect(errorActionForCode("LLM_KEY_REQUIRED")).toEqual({
      label: "去配置",
      href: "/more/model",
    });
    expect(errorActionForCode("LLM_KEY_INVALID")).toEqual({
      label: "去配置",
      href: "/more/model",
    });
  });

  it("offers no config action for codes fixed by retry / off-app", () => {
    expect(errorActionForCode("LLM_INSUFFICIENT_BALANCE")).toBeNull();
    expect(errorActionForCode("QUOTA_EXCEEDED")).toBeNull();
    expect(errorActionForCode(undefined)).toBeNull();
  });

  it("streamErrorAction delegates to the code map for a StreamError", () => {
    expect(
      streamErrorAction(
        new StreamError("http", 402, { code: "LLM_KEY_REQUIRED" }),
      ),
    ).toEqual({ label: "去配置", href: "/more/model" });
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

    const err = await streamConversation({
      conversationId: "c1",
      content: "hi",
      attachments: [],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StreamError);
    const streamErr = err as StreamError;
    expect(streamErr.status).toBe(429);
    expect(streamErr.code).toBe("RATE_LIMITED");
    expect(streamErr.serverMessage).toBe("操作过于频繁，请约 42 秒后再发送。");
    expect(streamErr.retryAfter).toBe(42);
  });
});
