import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "../streamingMarkdown";

/** 测试用：冻结前缀 + 尾块两分视图。 */
function splitStreamingMarkdown(content: string): {
  stable: string;
  tail: string;
} {
  const blocks = splitMarkdownBlocks(content);
  if (blocks.length <= 1) return { stable: "", tail: content };
  const tail = blocks[blocks.length - 1];
  return { stable: blocks.slice(0, -1).join(""), tail };
}

function expectLossless(content: string): {
  stable: string;
  tail: string;
} {
  const split = splitStreamingMarkdown(content);
  expect(split.stable + split.tail).toBe(content);
  return split;
}

function expectBlocksLossless(content: string): string[] {
  const blocks = splitMarkdownBlocks(content);
  expect(blocks.join("")).toBe(content);
  return blocks;
}

describe("splitMarkdownBlocks (mobile)", () => {
  it("没有空行时整体落入尾块", () => {
    const { stable, tail } = expectLossless("一个还在写的段落，没有任何空行");
    expect(stable).toBe("");
    expect(tail).toBe("一个还在写的段落，没有任何空行");
  });

  it("空串返回空", () => {
    const { stable, tail } = expectLossless("");
    expect(stable).toBe("");
    expect(tail).toBe("");
  });

  it("两段之间的空行处切分", () => {
    const { stable, tail } = expectLossless("第一段。\n\n第二段还在写");
    expect(stable).toBe("第一段。\n\n");
    expect(tail).toBe("第二段还在写");
  });

  it("松散列表整体不被劈开", () => {
    const content = "- 第一项\n\n- 第二项\n\n- 第三项";
    const { stable, tail } = expectLossless(content);
    expect(stable).toBe("");
    expect(tail).toBe(content);
  });

  it("栅栏代码块内部的空行不触发切分", () => {
    const content = "```py\na = 1\n\nb = 2\n```\n\n后文";
    const { stable, tail } = expectLossless(content);
    expect(stable).toBe("```py\na = 1\n\nb = 2\n```\n\n");
    expect(tail).toBe("后文");
  });

  it("多块拼接无损", () => {
    const content = "# 标题\n\n段落一。\n\n段落二\n\n段落三";
    const blocks = expectBlocksLossless(content);
    expect(blocks.length).toBeGreaterThan(1);
  });
});
