import {
  type BoardElement,
  type BoardSkeleton,
  applyExistingEdits,
  applyGroups,
  buildNodeSkeletons,
  mergeAppliedScene,
} from "@/services/boardOps";
import { describe, expect, it } from "vitest";

type NodeSkeleton = Exclude<BoardSkeleton, { type: "arrow" }>;
const arrowOf = (sks: BoardSkeleton[]) => sks.find((s) => s.type === "arrow");
const nodesOf = (sks: BoardSkeleton[]): NodeSkeleton[] =>
  sks.filter((s): s is NodeSkeleton => s.type !== "arrow");

describe("buildNodeSkeletons", () => {
  it("maps a sticky add_node to a rectangle with a generated id, label, and bg", () => {
    const { skeletons, createdIds } = buildNodeSkeletons([
      { op: "add_node", ref: "a", text: "Hello" },
    ]);
    const [sk] = nodesOf(skeletons);
    expect(sk).toMatchObject({ type: "rectangle", label: { text: "Hello" } });
    // The node's id is generated (collision-proof) and reported as created.
    expect(createdIds).toEqual([sk.id]);
    expect(sk.id).toMatch(/^brd-/);
    expect("backgroundColor" in sk && sk.backgroundColor).toBeTruthy();
  });

  it("maps a text node to a text element carrying the text", () => {
    const { skeletons } = buildNodeSkeletons([
      { op: "add_node", ref: "t", kind: "text", text: "note" },
    ]);
    expect(skeletons[0]).toMatchObject({ type: "text", text: "note" });
  });

  it("auto-lays-out nodes that omit coordinates (no pile at 0,0)", () => {
    const { skeletons } = buildNodeSkeletons([
      { op: "add_node", ref: "a" },
      { op: "add_node", ref: "b" },
    ]);
    expect(skeletons[0].x).toBeGreaterThan(0);
    expect(
      skeletons[1].x === skeletons[0].x && skeletons[1].y === skeletons[0].y,
    ).toBe(false);
  });

  it("honors explicit coordinates", () => {
    const { skeletons } = buildNodeSkeletons([
      { op: "add_node", ref: "a", x: 42, y: 99 },
    ]);
    expect(skeletons[0].x).toBe(42);
    expect(skeletons[0].y).toBe(99);
  });

  it("binds a connect between two same-batch refs into an arrow", () => {
    const { skeletons } = buildNodeSkeletons([
      { op: "add_node", ref: "a" },
      { op: "add_node", ref: "b" },
      { op: "connect", from: "a", to: "b", label: "depends" },
    ]);
    const [a, b] = nodesOf(skeletons);
    expect(arrowOf(skeletons)).toMatchObject({
      type: "arrow",
      start: { id: a.id },
      end: { id: b.id },
      label: { text: "depends" },
    });
  });

  it("binds a connect to an EXISTING bindable node via a passthrough skeleton", () => {
    const existing = new Map<string, BoardElement>([
      ["x", { id: "x", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }],
    ]);
    const { skeletons } = buildNodeSkeletons(
      [
        { op: "add_node", ref: "a" },
        { op: "connect", from: "a", to: "x" },
      ],
      existing,
    );
    // A passthrough for the live element "x" is emitted (so the converter can bind to it).
    const passthrough = nodesOf(skeletons).find((s) => s.id === "x");
    expect(passthrough).toMatchObject({ type: "rectangle", id: "x" });
    const newNode = nodesOf(skeletons).find((s) => s.id !== "x");
    expect(arrowOf(skeletons)).toMatchObject({
      start: { id: newNode?.id },
      end: { id: "x" },
    });
  });

  it("emits a passthrough only once for an existing endpoint used twice", () => {
    const existing = new Map<string, BoardElement>([
      ["x", { id: "x", type: "ellipse", x: 0, y: 0, width: 80, height: 80 }],
      [
        "y",
        { id: "y", type: "rectangle", x: 200, y: 0, width: 80, height: 40 },
      ],
    ]);
    const { skeletons } = buildNodeSkeletons(
      [
        { op: "connect", from: "x", to: "y" },
        { op: "connect", from: "y", to: "x" },
      ],
      existing,
    );
    expect(nodesOf(skeletons).filter((s) => s.id === "x")).toHaveLength(1);
    expect(skeletons.filter((s) => s.type === "arrow")).toHaveLength(2);
  });

  it("skips a connect to a non-bindable existing element (text)", () => {
    const existing = new Map<string, BoardElement>([
      ["a", { id: "a", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }],
      ["t", { id: "t", type: "text", x: 0, y: 0, text: "hi" }],
    ]);
    const { skeletons } = buildNodeSkeletons(
      [{ op: "connect", from: "a", to: "t" }],
      existing,
    );
    expect(arrowOf(skeletons)).toBeUndefined();
  });

  it("skips a connect to an unknown id (not a ref, not in the scene)", () => {
    const { skeletons } = buildNodeSkeletons([
      { op: "add_node", ref: "a" },
      { op: "connect", from: "a", to: "ghost" },
    ]);
    expect(arrowOf(skeletons)).toBeUndefined();
  });
});

describe("mergeAppliedScene", () => {
  it("appends brand-new converted elements not present in the scene", () => {
    const edited: BoardElement[] = [{ id: "x", type: "rectangle" }];
    const converted: BoardElement[] = [
      { id: "brd-1", type: "rectangle" },
      { id: "arrow-1", type: "arrow" },
    ];
    const out = mergeAppliedScene(edited, converted);
    expect(out.map((e) => e.id)).toEqual(["x", "brd-1", "arrow-1"]);
  });

  it("merges boundElements onto a passthrough's live element (not re-added)", () => {
    const edited: BoardElement[] = [{ id: "x", type: "rectangle" }];
    const converted: BoardElement[] = [
      {
        id: "x",
        type: "rectangle",
        boundElements: [{ id: "arrow-1", type: "arrow" }],
      },
      { id: "arrow-1", type: "arrow" },
    ];
    const out = mergeAppliedScene(edited, converted);
    // "x" appears once, now carrying the arrow.
    expect(out.filter((e) => e.id === "x")).toHaveLength(1);
    expect(out.find((e) => e.id === "x")?.boundElements).toEqual([
      { id: "arrow-1", type: "arrow" },
    ]);
  });

  it("preserves + dedupes existing boundElements when merging", () => {
    const edited: BoardElement[] = [
      {
        id: "x",
        type: "rectangle",
        boundElements: [{ id: "label-1", type: "text" }],
      },
    ];
    const converted: BoardElement[] = [
      {
        id: "x",
        type: "rectangle",
        boundElements: [
          { id: "label-1", type: "text" }, // already there → not duplicated
          { id: "arrow-1", type: "arrow" },
        ],
      },
    ];
    const out = mergeAppliedScene(edited, converted);
    expect(out.find((e) => e.id === "x")?.boundElements).toEqual([
      { id: "label-1", type: "text" },
      { id: "arrow-1", type: "arrow" },
    ]);
  });

  it("leaves an existing element without a passthrough untouched", () => {
    const edited: BoardElement[] = [{ id: "x", type: "rectangle" }];
    const out = mergeAppliedScene(edited, []);
    expect(out).toEqual(edited);
  });
});

describe("applyExistingEdits", () => {
  const scene = (): BoardElement[] => [
    { id: "x", type: "rectangle", x: 0, y: 0 },
    { id: "t", type: "text", x: 0, y: 0, text: "old" },
  ];

  it("moves an existing element by id", () => {
    const out = applyExistingEdits(scene(), [
      { op: "move", id: "x", x: 50, y: 60 },
    ]);
    expect(out.find((e) => e.id === "x")).toMatchObject({ x: 50, y: 60 });
  });

  it("deletes an existing element by id", () => {
    const out = applyExistingEdits(scene(), [{ op: "delete", id: "x" }]);
    expect(out.some((e) => e.id === "x")).toBe(false);
    expect(out.some((e) => e.id === "t")).toBe(true);
  });

  it("rewrites the text of a text element", () => {
    const out = applyExistingEdits(scene(), [
      { op: "set_text", id: "t", text: "new" },
    ]);
    expect(out.find((e) => e.id === "t")?.text).toBe("new");
  });

  it("ignores an op whose target id is absent", () => {
    const out = applyExistingEdits(scene(), [
      { op: "move", id: "ghost", x: 9, y: 9 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const input = scene();
    applyExistingEdits(input, [{ op: "delete", id: "x" }]);
    expect(input).toHaveLength(2);
  });
});

describe("applyGroups", () => {
  it("stamps a shared groupId on resolvable members (by real id)", () => {
    const els: BoardElement[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    applyGroups(els, [{ op: "group", members: ["a", "b"] }]);
    const ga = els[0].groupIds?.[0];
    expect(ga).toBeTruthy();
    expect(els[1].groupIds?.[0]).toBe(ga);
    expect(els[2].groupIds ?? []).toHaveLength(0);
  });

  it("resolves new-node refs to their generated ids via refToId", () => {
    // The scene holds the generated ids; the group op references the AI's refs.
    const els: BoardElement[] = [{ id: "brd-1" }, { id: "brd-2" }];
    const refToId = new Map([
      ["a", "brd-1"],
      ["b", "brd-2"],
    ]);
    applyGroups(els, [{ op: "group", members: ["a", "b"] }], refToId);
    const ga = els[0].groupIds?.[0];
    expect(ga).toBeTruthy();
    expect(els[1].groupIds?.[0]).toBe(ga);
  });

  it("mixes a new-node ref and an existing id in one group", () => {
    const els: BoardElement[] = [{ id: "brd-1" }, { id: "real-x" }];
    const refToId = new Map([["a", "brd-1"]]);
    applyGroups(els, [{ op: "group", members: ["a", "real-x"] }], refToId);
    expect(els[0].groupIds?.[0]).toBeTruthy();
    expect(els[1].groupIds?.[0]).toBe(els[0].groupIds?.[0]);
  });
});
