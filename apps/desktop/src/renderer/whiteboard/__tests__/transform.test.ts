import { describe, expect, it } from "vitest";
import type { Box } from "../geometry";
import {
  normalizeFreedraw,
  resizeBox,
  scaleElements,
  syncArrowBox,
} from "../transform";
import type { SceneElement } from "../types";

function rect(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
): SceneElement {
  return { id, type: "rectangle", x, y, width, height, schemaVersion: 1 };
}

const BOX_100: Box = { x: 0, y: 0, width: 100, height: 100 };

describe("resizeBox", () => {
  it("free-drags the east edge, leaving the cross axis fixed", () => {
    expect(resizeBox(BOX_100, "e", 150, 999, false)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 100,
    });
  });

  it("free-drags the north edge upward (grows height, moves y)", () => {
    expect(resizeBox(BOX_100, "n", 999, -30, false)).toEqual({
      x: 0,
      y: -30,
      width: 100,
      height: 130,
    });
  });

  it("clamps to the 8px minimum size", () => {
    expect(resizeBox(BOX_100, "e", 2, 0, false)).toEqual({
      x: 0,
      y: 0,
      width: 8,
      height: 100,
    });
  });

  it("preserves the aspect ratio on a corner drag with lockAspect", () => {
    // se corner, cursor pushes x further → y follows to keep the 1:1 ratio.
    expect(resizeBox(BOX_100, "se", 200, 150, true)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
  });
});

describe("scaleElements", () => {
  it("scales selected elements proportionally from the anchor", () => {
    const base = [rect("a", 0, 0), rect("b", 200, 0)];
    const next = scaleElements(
      base,
      new Set(["a", "b"]),
      { x: 0, y: 0, width: 300, height: 100 },
      "e",
      600,
      0,
      false,
    );
    const a = next.find((e) => e.id === "a");
    const b = next.find((e) => e.id === "b");
    // scaleX = 600/300 = 2, scaleY = 1, anchor at x=0.
    expect(a).toMatchObject({ x: 0, width: 200, height: 100 });
    expect(b).toMatchObject({ x: 400, width: 200, height: 100 });
  });

  it("leaves unselected and locked elements untouched (same ref)", () => {
    const unselected = rect("u", 1000, 0);
    const locked: SceneElement = { ...rect("l", 0, 0), locked: true };
    const base = [rect("a", 0, 0), unselected, locked];
    const next = scaleElements(
      base,
      new Set(["a", "l"]),
      BOX_100,
      "e",
      200,
      0,
      false,
    );
    expect(next.find((e) => e.id === "u")).toBe(unselected);
    expect(next.find((e) => e.id === "l")).toBe(locked);
  });

  it("translates + scales linear element points", () => {
    const line: SceneElement = {
      id: "L",
      type: "line",
      x: 10,
      y: 10,
      width: 100,
      height: 0,
      points: [
        [10, 10],
        [110, 10],
      ],
      schemaVersion: 1,
    };
    const next = scaleElements(
      [line],
      new Set(["L"]),
      { x: 10, y: 10, width: 100, height: 100 },
      "se",
      210,
      210,
      false,
    );
    // scaleX = scaleY = 2, anchor (10,10).
    expect(next[0].points).toEqual([
      [10, 10],
      [210, 10],
    ]);
  });
});

describe("syncArrowBox", () => {
  it("recomputes the bbox from world points", () => {
    const el: SceneElement = {
      id: "arr",
      type: "arrow",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      points: [
        [5, 8],
        [25, 3],
      ],
      schemaVersion: 1,
    };
    syncArrowBox(el);
    expect(el).toMatchObject({ x: 5, y: 3, width: 20, height: 5 });
  });

  it("is a no-op with no points", () => {
    const el = rect("r", 1, 2);
    syncArrowBox(el);
    expect(el).toMatchObject({ x: 1, y: 2, width: 100, height: 100 });
  });
});

describe("normalizeFreedraw", () => {
  it("recenters the bbox to the points' min corner (single point → smoothing no-op)", () => {
    const el: SceneElement = {
      id: "f",
      type: "freedraw",
      x: 10,
      y: 20,
      width: 0,
      height: 0,
      points: [[5, 7]],
      schemaVersion: 1,
    };
    normalizeFreedraw(el);
    expect(el).toMatchObject({ x: 15, y: 27, width: 0, height: 0 });
    expect(el.points).toEqual([[0, 0]]);
  });

  it("is a no-op with an empty points array", () => {
    const el: SceneElement = {
      id: "f",
      type: "freedraw",
      x: 3,
      y: 4,
      width: 0,
      height: 0,
      points: [],
      schemaVersion: 1,
    };
    normalizeFreedraw(el);
    expect(el).toMatchObject({ x: 3, y: 4 });
    expect(el.points).toEqual([]);
  });
});
