import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MERMAID_INLINE_FIGURE_FILL,
  MERMAID_INLINE_MAX_UPSCALE,
  inlineMermaidWidthPx,
} from "../inlineMermaidWidth";

describe("inlineMermaidWidthPx", () => {
  it("grows a small chart but stops at the figure cap (not full-bleed)", () => {
    const column = 700;
    const native = 400;
    const w = inlineMermaidWidthPx(native, column);
    const cap = Math.round(column * MERMAID_INLINE_FIGURE_FILL);
    const grown = Math.round(native * MERMAID_INLINE_MAX_UPSCALE);
    expect(w).toBe(Math.min(grown, cap));
    expect(w).toBeLessThan(column);
    expect(w).toBeGreaterThan(native);
  });

  it("lets a near-column chart keep its native width (does not shrink it)", () => {
    expect(inlineMermaidWidthPx(640, 700)).toBe(640);
  });

  it("shrinks an oversized chart to the column", () => {
    expect(inlineMermaidWidthPx(1200, 700)).toBe(700);
  });

  it("falls back to upscaled native when the column is not laid out yet", () => {
    expect(inlineMermaidWidthPx(320, 0)).toBe(
      Math.round(320 * MERMAID_INLINE_MAX_UPSCALE),
    );
  });
});

describe("inlineMermaidWidth cross-platform parity", () => {
  it("the desktop and mobile copies stay identical", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const desktop = resolve(here, "../inlineMermaidWidth.ts");
    const mobile = resolve(
      here,
      "../../../../../mobile/src/lib/inlineMermaidWidth.ts",
    );
    const read = (p: string) =>
      readFileSync(p, "utf8").replace(/\r\n/g, "\n").trimEnd();
    expect(read(desktop)).toBe(read(mobile));
  });
});
