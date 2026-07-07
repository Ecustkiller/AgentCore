import { describe, expect, it } from "vitest";
import {
  DEFAULT_BYOK_PROVIDER_ID,
  getByokProviderPreset,
  normalizeByokBaseUrl,
  resolveByokProviderFromConfig,
} from "@/lib/byokProviderPresets";

describe("normalizeByokBaseUrl", () => {
  it("lowercases and strips trailing slashes", () => {
    expect(normalizeByokBaseUrl("HTTPS://API.OpenAI.com/v1/")).toBe(
      "https://api.openai.com/v1",
    );
  });
});

describe("resolveByokProviderFromConfig", () => {
  it("defaults empty base_url to OpenAI preset", () => {
    expect(resolveByokProviderFromConfig("")).toBe(DEFAULT_BYOK_PROVIDER_ID);
  });

  it("matches canonical preset base_url", () => {
    expect(resolveByokProviderFromConfig("https://api.openai.com/v1")).toBe(
      "openai",
    );
    expect(
      resolveByokProviderFromConfig("https://open.bigmodel.cn/api/paas/v4"),
    ).toBe("zhipu");
  });

  it("matches aliases (DeepSeek /v1, Moonshot international)", () => {
    expect(resolveByokProviderFromConfig("https://api.deepseek.com/v1")).toBe(
      "deepseek",
    );
    expect(resolveByokProviderFromConfig("https://api.moonshot.ai/v1")).toBe(
      "moonshot",
    );
  });

  it("falls back to custom for unknown endpoints", () => {
    expect(resolveByokProviderFromConfig("https://my-proxy.example/v1")).toBe(
      "custom",
    );
  });

  it("treats trailing slash variants as the same preset", () => {
    expect(resolveByokProviderFromConfig("https://api.deepseek.com/")).toBe(
      "deepseek",
    );
  });
});

describe("getByokProviderPreset", () => {
  it("returns preset metadata for known ids", () => {
    const preset = getByokProviderPreset("deepseek");
    expect(preset.baseUrl).toBe("https://api.deepseek.com");
    expect(preset.models).toContain("deepseek-v4-pro");
  });
});
