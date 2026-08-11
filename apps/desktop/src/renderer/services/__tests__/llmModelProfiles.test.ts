import {
  type LlmModelProfileView,
  profileSlotSummary,
  slotDisplayName,
} from "@/services/llmModelProfiles";
import { describe, expect, it } from "vitest";

const CATALOG = [
  {
    id: "deepseek-v4-pro",
    origin: "byok",
    display_name: "DeepSeek V4 Pro",
    provider_id: "prov-deepseek",
  },
  {
    id: "gpt-4o-mini",
    origin: "byok",
    display_name: "GPT-4o mini",
    provider_id: "prov-openai",
  },
  {
    id: "gpt-4o",
    origin: "byok",
    display_name: "GPT-4o",
    provider_id: "prov-openai",
  },
];

function profile(
  overrides: Partial<LlmModelProfileView> = {},
): LlmModelProfileView {
  return {
    id: "p1",
    name: "日常",
    kind: "user",
    main: {
      origin: "byok",
      model: "deepseek-v4-pro",
      provider_id: "prov-deepseek",
    },
    worker: null,
    background: null,
    vision: null,
    is_default: false,
    ...overrides,
  };
}

describe("slotDisplayName", () => {
  it("prefers catalog display_name", () => {
    expect(
      slotDisplayName(
        {
          origin: "byok",
          model: "deepseek-v4-pro",
          provider_id: "prov-deepseek",
        },
        CATALOG,
      ),
    ).toBe("DeepSeek V4 Pro");
  });
});

describe("profileSlotSummary", () => {
  it("shows 主 · Worker and 跟随主模型 when worker is empty", () => {
    expect(profileSlotSummary(profile(), CATALOG)).toBe(
      "DeepSeek V4 Pro · 跟随主模型",
    );
  });

  it("shows worker display name when set", () => {
    expect(
      profileSlotSummary(
        profile({
          worker: {
            origin: "byok",
            model: "gpt-4o-mini",
            provider_id: "prov-openai",
          },
        }),
        CATALOG,
      ),
    ).toBe("DeepSeek V4 Pro · GPT-4o mini");
  });

  it("appends 后台 / 识图 only when those slots are configured", () => {
    expect(
      profileSlotSummary(
        profile({
          background: {
            origin: "byok",
            model: "gpt-4o-mini",
            provider_id: "prov-openai",
          },
          vision: {
            origin: "byok",
            model: "gpt-4o",
            provider_id: "prov-openai",
          },
        }),
        CATALOG,
      ),
    ).toBe("DeepSeek V4 Pro · 跟随主模型 · 后台 GPT-4o mini · 识图 GPT-4o");
  });

  it("does not mention 后台 / 识图 when unset (keeps list rows compact)", () => {
    const summary = profileSlotSummary(profile(), CATALOG);
    expect(summary).not.toContain("后台");
    expect(summary).not.toContain("识图");
  });
});
