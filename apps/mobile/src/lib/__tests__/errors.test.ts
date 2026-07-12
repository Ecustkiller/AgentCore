import { describe, expect, it } from "vitest";
import {
  MODEL_CONFIG_PATH,
  StreamHttpError,
  describeStreamHttpError,
  emptyChatCopy,
  errorActionForCode,
  hasModelAccess,
} from "../errors";

describe("errorActionForCode", () => {
  it("routes LLM_KEY_REQUIRED to 去配置", () => {
    expect(errorActionForCode("LLM_KEY_REQUIRED")).toEqual({
      label: "去配置",
      href: MODEL_CONFIG_PATH,
    });
  });

  it("routes LLM_KEY_INVALID to 去配置", () => {
    expect(errorActionForCode("LLM_KEY_INVALID")).toEqual({
      label: "去配置",
      href: MODEL_CONFIG_PATH,
    });
  });

  it("returns null for unrelated codes", () => {
    expect(errorActionForCode("QUOTA_EXCEEDED")).toBeNull();
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
  it("guides unconfigured users to connect a model", () => {
    const copy = emptyChatCopy(false);
    expect(copy.title).toBe("先连接你的模型");
    expect(copy.action).toEqual({
      label: "去配置",
      href: MODEL_CONFIG_PATH,
    });
  });

  it("keeps the welcome copy when a key is configured", () => {
    const copy = emptyChatCopy(true);
    expect(copy.title).toBe("开始新对话");
    expect(copy.subtitle).toContain("Agent 团队");
    expect(copy.action).toBeNull();
  });
});

describe("hasModelAccess", () => {
  it("treats a configured BYOK key as access", () => {
    expect(hasModelAccess({ configured: true })).toBe(true);
  });

  it("treats platform billing as access even without a BYOK key", () => {
    expect(
      hasModelAccess({ configured: false, billing_mode: "platform" }),
    ).toBe(true);
  });

  it("denies access when unconfigured and not platform-billed", () => {
    expect(hasModelAccess({ configured: false, billing_mode: "byok" })).toBe(
      false,
    );
    expect(hasModelAccess({ configured: false })).toBe(false);
    expect(hasModelAccess(null)).toBe(false);
  });
});
