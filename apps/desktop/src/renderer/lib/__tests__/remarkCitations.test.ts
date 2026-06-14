import { remarkCitations, splitCitationText } from "@/lib/remarkCitations";
import { describe, expect, it } from "vitest";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const cite = (n: number): MdNode => ({
  type: "link",
  url: `cite:${n}`,
  children: [{ type: "text", value: String(n) }],
});

describe("splitCitationText", () => {
  it("converts in-range markers to cite links and keeps surrounding text", () => {
    expect(splitCitationText("see [1] and [2] here", 2)).toEqual([
      { type: "text", value: "see " },
      cite(1),
      { type: "text", value: " and " },
      cite(2),
      { type: "text", value: " here" },
    ]);
  });

  it("leaves out-of-range markers as literal text", () => {
    // max=1, so [2] is not a real source → stays text.
    expect(splitCitationText("a [1] b [2]", 1)).toEqual([
      { type: "text", value: "a " },
      cite(1),
      { type: "text", value: " b [2]" },
    ]);
  });

  it("returns the value untouched when there is no in-range marker", () => {
    expect(splitCitationText("no markers [0] [9]", 2)).toEqual([
      { type: "text", value: "no markers [0] [9]" },
    ]);
  });
});

describe("remarkCitations attacher", () => {
  const run = (tree: MdNode, max: number) => {
    remarkCitations(max)()(tree);
    return tree;
  };

  it("rewrites markers inside paragraph text", () => {
    const tree: MdNode = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "x [1] y" }] },
      ],
    };
    run(tree, 1);
    expect(tree.children?.[0]?.children).toEqual([
      { type: "text", value: "x " },
      cite(1),
      { type: "text", value: " y" },
    ]);
  });

  it("does not touch markers inside code or existing links", () => {
    const tree: MdNode = {
      type: "root",
      children: [
        { type: "inlineCode", value: "arr[1]" },
        {
          type: "link",
          url: "https://e.com",
          children: [{ type: "text", value: "ref [1]" }],
        },
      ],
    };
    run(tree, 5);
    expect(tree.children?.[0]).toEqual({ type: "inlineCode", value: "arr[1]" });
    expect(tree.children?.[1]?.children).toEqual([
      { type: "text", value: "ref [1]" },
    ]);
  });

  it("is a no-op when there are no sources (max=0)", () => {
    const tree: MdNode = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "a [1] b" }] },
      ],
    };
    run(tree, 0);
    expect(tree.children?.[0]?.children).toEqual([
      { type: "text", value: "a [1] b" },
    ]);
  });
});
