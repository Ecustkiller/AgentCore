import { describe, expect, it } from "vitest";
import {
  WINDOW_FILL_WARN_RATIO,
  captainCompletedModel,
  captainLastPrompt,
  catalogContextLength,
  positiveTokens,
  windowFill,
  windowFillLabel,
} from "../windowFill";

describe("windowFill", () => {
  it("returns null without a real used/window pair", () => {
    expect(windowFill(0, 1_000_000)).toBeNull();
    expect(windowFill(12_000, 0)).toBeNull();
    expect(windowFill(Number.NaN, 1_000_000)).toBeNull();
  });

  it("uses last-prompt / catalog window, not a char heuristic", () => {
    const fill = windowFill(120_000, 1_000_000);
    expect(fill).toEqual({
      used: 120_000,
      window: 1_000_000,
      ratio: 0.12,
      percent: 12,
    });
    expect(windowFillLabel(fill, 120_000)).toBe("120.0k / 1.0M");
    expect(windowFillLabel(null, 120_000)).toBe("120.0k");
    expect(windowFillLabel(null, null)).toBe("收到的上下文");
  });

  it("keeps percent honest above 100 and still warns at the compaction line", () => {
    const over = windowFill(1_100_000, 1_000_000);
    expect(over?.percent).toBe(110);
    expect(over && over.ratio >= WINDOW_FILL_WARN_RATIO).toBe(true);
  });
});

describe("captainLastPrompt", () => {
  it("prefers captain run_completed last_prompt over summed-looking message usage", () => {
    expect(
      captainLastPrompt(
        [
          {
            kind: "run_completed",
            role: "member",
            usage: { last_prompt: 800_000 },
          },
          {
            kind: "run_completed",
            role: "captain",
            usage: { last_prompt: 50_000 },
          },
        ],
        { last_prompt: 999_999 },
      ),
    ).toBe(50_000);
  });

  it("falls back to message.usage when the captain frame has no last_prompt", () => {
    expect(
      captainLastPrompt(
        [{ kind: "run_completed", role: "captain", usage: { last_prompt: 0 } }],
        { last_prompt: 12_000 },
      ),
    ).toBe(12_000);
    expect(captainLastPrompt([], { last_prompt: 12_000 })).toBe(12_000);
    expect(positiveTokens(0)).toBeNull();
  });

  it("reads the captain model id from the same completed frame", () => {
    expect(
      captainCompletedModel([
        { kind: "run_completed", role: "captain", model: "deepseek-v4-flash" },
      ]),
    ).toBe("deepseek-v4-flash");
  });
});

describe("catalogContextLength", () => {
  const models = [
    {
      id: "deepseek-v4-flash",
      origin: "platform" as const,
      display_name: "Flash",
      vendor: "DeepSeek",
      ref: "@platform/deepseek-v4-flash",
      available: true,
      context_length: 1_000_000,
    },
    {
      id: "opencode-zen-free",
      origin: "platform" as const,
      display_name: "Zen",
      vendor: "OpenCode",
      ref: "@platform/opencode-zen-free",
      available: true,
      context_length: 200_000,
    },
  ];

  it("prefers the completed-run model id, then the profile slot", () => {
    expect(
      catalogContextLength(models, {
        modelId: "opencode-zen-free",
        slot: { model: "deepseek-v4-flash", origin: "platform" },
      }),
    ).toBe(200_000);
    expect(
      catalogContextLength(models, {
        slot: { model: "deepseek-v4-flash", origin: "platform" },
      }),
    ).toBe(1_000_000);
  });
});
