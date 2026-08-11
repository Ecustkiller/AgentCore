import { describe, expect, it } from "vitest";
import {
  MODEL_CONFIG_PATH,
  StreamHttpError,
  degradedFinishChipLabel,
  describeStreamHttpError,
  emptyChatCopy,
  emptyFailureNotice,
  emptyFailureVisibleNotice,
  errorActionForCode,
  isEmptyResponseUserSurface,
  resolveEmptyFailureNotice,
} from "../errors";

describe("errorActionForCode", () => {
  it("routes LLM_KEY_REQUIRED to 去配置", () => {
    expect(errorActionForCode("LLM_KEY_REQUIRED")).toEqual({
      label: "去配置",
      href: MODEL_CONFIG_PATH,
    });
  });

  it("routes LLM_KEY_INVALID to 去配置 (BYOK) or 接入自己的 Key (platform)", () => {
    expect(errorActionForCode("LLM_KEY_INVALID")).toEqual({
      label: "去配置",
      href: MODEL_CONFIG_PATH,
    });
    expect(
      errorActionForCode("LLM_KEY_INVALID", { credentialSource: "platform" }),
    ).toEqual({
      label: "接入自己的 Key",
      href: MODEL_CONFIG_PATH,
    });
  });

  it("offers a BYOK secondary exit for QUOTA_EXCEEDED (F6), null otherwise", () => {
    expect(errorActionForCode("QUOTA_EXCEEDED")).toEqual({
      label: "接入自己的 Key",
      href: MODEL_CONFIG_PATH,
    });
    expect(errorActionForCode("SOME_UNKNOWN")).toBeNull();
    expect(errorActionForCode(undefined)).toBeNull();
  });
});

describe("describeStreamHttpError", () => {
  it("prefers the backend message for LLM_KEY_REQUIRED and offers 去配置", () => {
    const err = new StreamHttpError(
      402,
      "LLM_KEY_REQUIRED",
      "请先在「设置 · 模型配置」中填入你的 API Key，再发起对话。",
    );
    expect(describeStreamHttpError(err)).toEqual({
      message: "请先在「设置 · 模型配置」中填入你的 API Key，再发起对话。",
      action: { label: "去配置", href: MODEL_CONFIG_PATH },
    });
  });

  it("falls back to a config hint when the body has no message", () => {
    const err = new StreamHttpError(402, "LLM_KEY_REQUIRED");
    const d = describeStreamHttpError(err);
    expect(d.message).toContain("模型配置");
    expect(d.action?.label).toBe("去配置");
  });

  it("surfaces a generic status message without action when code is unknown", () => {
    const err = new StreamHttpError(500, undefined, undefined);
    expect(describeStreamHttpError(err)).toEqual({
      message: "请求失败 (500)",
      action: null,
    });
  });
});

describe("emptyChatCopy", () => {
  it("returns the no-gate welcome copy (platform-paid, keyless included)", () => {
    const copy = emptyChatCopy();
    expect(copy.title).toBe("开始新对话");
    expect(copy.subtitle).toContain("Agent 团队");
    expect(copy.action).toBeNull();
  });
});

describe("emptyFailureNotice", () => {
  it("explains empty error / unproductive finishes", () => {
    expect(emptyFailureNotice("error")).toBe("模型调用失败，请重试。");
    expect(emptyFailureNotice("unproductive")).toBe(
      "工具连续无有效进展或参数无效，请重试。",
    );
  });

  it("stays silent for normal / other finishes", () => {
    expect(emptyFailureNotice("end_turn")).toBeNull();
    expect(emptyFailureNotice("degraded")).toBeNull();
    expect(emptyFailureNotice(null)).toBeNull();
    expect(emptyFailureNotice(undefined)).toBeNull();
  });
});

describe("emptyFailureVisibleNotice", () => {
  it("prefers structured error.message over the generic finish notice", () => {
    expect(
      emptyFailureVisibleNotice("error", "API Key 已吊销，请重新配置。"),
    ).toBe("API Key 已吊销，请重新配置。");
  });

  it("falls back to emptyFailureNotice when error message is blank", () => {
    expect(emptyFailureVisibleNotice("error", "  ")).toBe(
      "模型调用失败，请重试。",
    );
    expect(emptyFailureVisibleNotice("error", null)).toBe(
      "模型调用失败，请重试。",
    );
    expect(emptyFailureVisibleNotice("unproductive", undefined)).toBe(
      "工具连续无有效进展或参数无效，请重试。",
    );
  });

  it("still surfaces a specific error when finishReason alone would be silent", () => {
    expect(emptyFailureVisibleNotice(null, "上游超时，请稍后重试。")).toBe(
      "上游超时，请稍后重试。",
    );
  });
});

describe("resolveEmptyFailureNotice (ChatPage gate)", () => {
  it("shows structured error on empty cold-load failure", () => {
    expect(
      resolveEmptyFailureNotice({
        content: "",
        finishReason: "error",
        errorMessage: "配额已用尽",
      }),
    ).toBe("配额已用尽");
  });

  it("uses generic notice when empty + failure finish + no error payload", () => {
    expect(
      resolveEmptyFailureNotice({
        content: null,
        finishReason: "error",
      }),
    ).toBe("模型调用失败，请重试。");
  });

  it("keeps non-empty content (half reply) — no failure line", () => {
    expect(
      resolveEmptyFailureNotice({
        content: "半成品答复",
        finishReason: "error",
        errorMessage: "后面又挂了",
      }),
    ).toBeNull();
  });

  it("skips while streaming / live", () => {
    expect(
      resolveEmptyFailureNotice({
        content: "",
        finishReason: "error",
        errorMessage: "不该在流式中出现",
        skip: true,
      }),
    ).toBeNull();
  });

  it("empty cancelled does not synthesize a failure notice", () => {
    expect(
      resolveEmptyFailureNotice({
        content: "",
        finishReason: "cancelled",
      }),
    ).toBeNull();
  });
});

describe("degradedFinishChipLabel", () => {
  it("maps known empty_diagnosis keys", () => {
    expect(degradedFinishChipLabel("silent_empty", undefined)).toBe(
      "模型返回空内容",
    );
    expect(degradedFinishChipLabel("upstream_non_api", undefined)).toBe(
      "上游返回了网页或登录页，请检查服务商地址与鉴权",
    );
    expect(degradedFinishChipLabel("oauth_expired", undefined)).toBe(
      "上游返回了网页或登录页，请检查服务商地址与鉴权",
    );
    expect(degradedFinishChipLabel("length_empty", undefined)).toBe(
      "输出长度截断 · 返回空内容",
    );
  });

  it("falls back to message suffix after ·", () => {
    expect(degradedFinishChipLabel(undefined, "降级 · 内容被过滤")).toBe(
      "内容被过滤",
    );
  });
});

describe("isEmptyResponseUserSurface", () => {
  it("detects LLM_EMPTY_RESPONSE / diagnosis / empty-response copy", () => {
    expect(isEmptyResponseUserSurface({ code: "LLM_EMPTY_RESPONSE" })).toBe(
      true,
    );
    expect(isEmptyResponseUserSurface({ emptyDiagnosis: "silent_empty" })).toBe(
      true,
    );
    expect(
      isEmptyResponseUserSurface({ message: "模型多次空响应后收尾" }),
    ).toBe(true);
    expect(isEmptyResponseUserSurface({ code: "LLM_TIMEOUT" })).toBe(false);
  });
});
