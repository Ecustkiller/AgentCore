import { type TimelineNode, groupToolRuns } from "@/lib/processTimeline";
import type { ProcessStep } from "@/types/events";
import { describe, expect, it } from "vitest";

const reasoning = (text: string): ProcessStep => ({ kind: "reasoning", text });
const content = (text: string): ProcessStep => ({ kind: "content", text });
const tool = (
  id: string,
  tool_name = "file_read",
  status: "running" | "success" | "error" = "success",
): ProcessStep => ({
  kind: "tool",
  id,
  tool_name,
  arguments: {},
  result: null,
  status,
});

describe("groupToolRuns", () => {
  it("returns [] for an empty timeline", () => {
    expect(groupToolRuns([])).toEqual([]);
  });

  it("folds a run of ≥2 consecutive tools into one tool-group, in order", () => {
    const nodes = groupToolRuns([tool("a"), tool("b"), tool("c")]);
    expect(nodes).toHaveLength(1);
    const group = nodes[0];
    expect(group.kind).toBe("tool-group");
    if (group.kind !== "tool-group") throw new Error("expected tool-group");
    expect(group.tools.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps a lone tool inline (threshold ≥2 — singles are not wrapped)", () => {
    const nodes = groupToolRuns([tool("a")]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "tool", step: { id: "a" } });
  });

  it("breaks runs on reasoning/content boundaries, preserving chronology", () => {
    const nodes = groupToolRuns([
      reasoning("想一下"),
      tool("a"),
      tool("b"),
      reasoning("再想"),
      tool("c"),
      content("答案"),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual([
      "reasoning",
      "tool-group", // a + b
      "reasoning",
      "tool", // lone c stays inline
      "content",
    ]);
    const group = nodes[1];
    if (group.kind !== "tool-group") throw new Error("expected tool-group");
    expect(group.tools.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("never folds the trailing content (final answer) into a group", () => {
    const nodes = groupToolRuns([tool("a"), tool("b"), content("最终答案")]);
    const last = nodes[nodes.length - 1] as TimelineNode;
    expect(last.kind).toBe("content");
    if (last.kind !== "content") throw new Error("expected content");
    expect(last.text).toBe("最终答案");
  });

  it("preserves per-step status inside a group (mixed running/success/error)", () => {
    const nodes = groupToolRuns([
      tool("a", "file_read", "success"),
      tool("b", "str_replace", "error"),
      tool("c", "file_list", "running"),
    ]);
    const group = nodes[0];
    if (group.kind !== "tool-group") throw new Error("expected tool-group");
    expect(group.tools.map((t) => t.status)).toEqual([
      "success",
      "error",
      "running",
    ]);
    expect(group.tools.map((t) => t.tool_name)).toEqual([
      "file_read",
      "str_replace",
      "file_list",
    ]);
  });

  it("folds two separate runs split by content into two nodes", () => {
    const nodes = groupToolRuns([
      tool("a"),
      tool("b"),
      content("中间正文"),
      tool("c"),
      tool("d"),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual([
      "tool-group",
      "content",
      "tool-group",
    ]);
  });

  it("does not mutate the input array", () => {
    const process: ProcessStep[] = [tool("a"), tool("b")];
    const snapshot = [...process];
    groupToolRuns(process);
    expect(process).toEqual(snapshot);
  });
});
