import { describe, expect, it } from "vitest";
import {
  MERMAID_FLOWCHART_LAYOUT,
  MERMAID_FONT_SIZE_PX,
  mermaidRenderConfig,
  toMermaidColor,
} from "../mermaidConfig";

/** hex or comma-rgba — the notations khroma actually parses. */
const KHROMA_COLOR =
  /^#[0-9a-f]{6}$|^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, \d+(?:\.\d+)?\)$/;

const COLOR_KEYS = [
  "background",
  "primaryColor",
  "primaryTextColor",
  "primaryBorderColor",
  "secondaryColor",
  "secondaryTextColor",
  "secondaryBorderColor",
  "tertiaryColor",
  "tertiaryTextColor",
  "tertiaryBorderColor",
  "lineColor",
  "textColor",
  "mainBkg",
  "nodeBorder",
  "clusterBkg",
  "clusterBorder",
  "titleColor",
  "edgeLabelBackground",
  "noteBkgColor",
  "noteTextColor",
  "noteBorderColor",
  "errorBkgColor",
  "errorTextColor",
  "altSectionBkgColor",
] as const;

describe("mermaidRenderConfig", () => {
  it("uses a compact flowchart layout and body-adjacent type", () => {
    const cfg = mermaidRenderConfig(false);
    expect(cfg.theme).toBe("base");
    expect(cfg.securityLevel).toBe("strict");
    expect(cfg.fontSize).toBe(MERMAID_FONT_SIZE_PX);
    expect(cfg.flowchart).toMatchObject({
      nodeSpacing: MERMAID_FLOWCHART_LAYOUT.nodeSpacing,
      rankSpacing: MERMAID_FLOWCHART_LAYOUT.rankSpacing,
      useMaxWidth: true,
    });
    expect(MERMAID_FLOWCHART_LAYOUT.nodeSpacing).toBeLessThan(50);
    expect(MERMAID_FLOWCHART_LAYOUT.rankSpacing).toBeLessThan(50);
  });

  it("maps diagrams to design tokens instead of mermaid stock palettes", () => {
    const light = mermaidRenderConfig(false);
    const dark = mermaidRenderConfig(true);
    expect(light.theme).toBe("base");
    expect(dark.theme).toBe("base");
    expect(light.themeVariables.darkMode).toBe(false);
    expect(dark.themeVariables.darkMode).toBe(true);
    expect(light.themeVariables.useGradient).toBe(false);
    expect(light.themeVariables.background).toBe("#ffffff");
    expect(light.themeVariables.primaryTextColor).toBe("#080b0f");
    expect(light.themeVariables.errorBkgColor).toBe("#df2225");
    expect(dark.themeVariables.background).toBe("#060709");
    expect(dark.themeVariables.primaryColor).toBe("#111314");
    expect(dark.themeVariables.primaryBorderColor).toBe(
      "rgba(255, 255, 255, 0.12)",
    );
    expect(light.themeVariables.primaryColor).not.toBe(
      dark.themeVariables.primaryColor,
    );
    for (const key of COLOR_KEYS) {
      expect(light.themeVariables[key]).toMatch(KHROMA_COLOR);
      expect(dark.themeVariables[key]).toMatch(KHROMA_COLOR);
    }
  });
});

describe("toMermaidColor", () => {
  it("converts oklch to the sRGB notation khroma accepts", () => {
    expect(toMermaidColor("oklch(1 0 0)", "#000000")).toBe("#ffffff");
    expect(toMermaidColor("oklch(0.58 0.22 27)", "#000000")).toBe("#df2225");
    expect(toMermaidColor("oklch(1 0 0 / 0.12)", "#000000")).toBe(
      "rgba(255, 255, 255, 0.12)",
    );
    expect(toMermaidColor("oklch(1 0 0 / 12%)", "#000000")).toBe(
      "rgba(255, 255, 255, 0.12)",
    );
  });

  it("normalizes hex and rgb, and does not forward other notations", () => {
    expect(toMermaidColor("#fff", "#000000")).toBe("#ffffff");
    expect(toMermaidColor("rgb(223, 34, 37)", "#000000")).toBe("#df2225");
    expect(toMermaidColor("lab(50% 0 0)", "oklch(1 0 0)")).toBe("#ffffff");
    expect(toMermaidColor("color-mix(in oklch, red, blue)", "nope")).toBe(
      "#000000",
    );
  });
});
