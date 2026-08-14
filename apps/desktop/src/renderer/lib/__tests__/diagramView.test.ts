import { describe, expect, it } from "vitest";
import {
  DIAGRAM_FIT_PADDING,
  DIAGRAM_MAX_SCALE,
  clampScale,
  fitContainView,
} from "../diagramView";

describe("fitContainView", () => {
  it("scales a small diagram up to fill the viewport (contain + padding)", () => {
    const view = fitContainView(1400, 800, 400, 200);
    expect(view).not.toBeNull();
    if (!view) throw new Error("expected view");
    // width-bound: 1400/400 = 3.5; height-bound 800/200 = 4 → 3.5 * 0.9
    expect(view.scale).toBeCloseTo(3.5 * DIAGRAM_FIT_PADDING);
    expect(view.x).toBeCloseTo((1400 - 400 * view.scale) / 2);
    expect(view.y).toBeCloseTo((800 - 200 * view.scale) / 2);
  });

  it("scales a huge diagram down so it fits", () => {
    const view = fitContainView(1000, 800, 2000, 500);
    expect(view).not.toBeNull();
    if (!view) throw new Error("expected view");
    expect(view.scale).toBeCloseTo((1000 / 2000) * DIAGRAM_FIT_PADDING);
  });

  it("returns null until layout boxes have size", () => {
    expect(fitContainView(0, 800, 400, 200)).toBeNull();
    expect(fitContainView(1400, 800, 0, 200)).toBeNull();
  });

  it("clamps to the zoom ceiling", () => {
    const view = fitContainView(8000, 8000, 10, 10);
    expect(view).not.toBeNull();
    if (!view) throw new Error("expected view");
    expect(view.scale).toBe(DIAGRAM_MAX_SCALE);
  });
});

describe("clampScale", () => {
  it("stays inside the zoom range", () => {
    expect(clampScale(0.01)).toBe(0.2);
    expect(clampScale(99)).toBe(DIAGRAM_MAX_SCALE);
    expect(clampScale(1.25)).toBe(1.25);
  });
});
