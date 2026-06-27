import type { BoardElement } from "@/services/boardOps";
import {
  describeSelection,
  organizeSelectionPrompt,
} from "@/services/boardTurn";
import { describe, expect, it } from "vitest";

const scene: BoardElement[] = [
  { id: "a", type: "rectangle", x: 10.4, y: 20.6, text: "登录" },
  { id: "b", type: "ellipse", x: 100, y: 200 },
  { id: "c", type: "text", x: 0, y: 0, text: "  说明  " },
];

describe("describeSelection", () => {
  it("renders one line per selected element with id, shape, rounded pos, and text", () => {
    const out = describeSelection(scene, ["a"]);
    expect(out).toBe("- [a] rectangle @(10,21)：“登录”");
  });

  it("omits text when an element has none", () => {
    expect(describeSelection(scene, ["b"])).toBe("- [b] ellipse @(100,200)");
  });

  it("trims surrounding whitespace from text", () => {
    expect(describeSelection(scene, ["c"])).toBe("- [c] text @(0,0)：“说明”");
  });

  it("skips selection ids not present in the scene (stale selection)", () => {
    const out = describeSelection(scene, ["ghost", "b"]);
    expect(out).toBe("- [b] ellipse @(100,200)");
  });

  it("joins multiple selected elements with newlines", () => {
    const out = describeSelection(scene, ["a", "b"]);
    expect(out.split("\n")).toHaveLength(2);
  });

  it("returns an empty string when nothing resolves", () => {
    expect(describeSelection(scene, ["x", "y"])).toBe("");
  });
});

describe("organizeSelectionPrompt", () => {
  it("embeds the selection description and asks the model to use board_ops", () => {
    const prompt = organizeSelectionPrompt("- [a] rectangle @(0,0)");
    expect(prompt).toContain("board_ops");
    expect(prompt).toContain("- [a] rectangle @(0,0)");
    expect(prompt).toContain("真实 id");
  });
});
