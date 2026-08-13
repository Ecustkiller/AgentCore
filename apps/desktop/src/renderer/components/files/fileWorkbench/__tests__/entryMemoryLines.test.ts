/**
 * entryMemoryLines — what「这条不对」actually silences, read off the entry body.
 */

import { describe, expect, it } from "vitest";
import { parseEntryMemoryLines } from "../entryMemoryLines";

const PREFERENCES = `---
apply: always
description: 沟通与工作习惯
---
# 用户记忆
> 本文件由 AI 自动维护，你可随时编辑或删除任何条目。

## 沟通偏好
- 你喜欢简洁的回答 <!-- ts:2026-07-19 -->
- 中文优先，术语保留英文原词

## 工作习惯
- 先给结论再给理由 <!-- ts:2026-08-01 -->
`;

describe("parseEntryMemoryLines", () => {
  it("lists every bullet with its section, past frontmatter and human chrome", () => {
    expect(parseEntryMemoryLines(PREFERENCES)).toEqual([
      { section: "沟通偏好", text: "你喜欢简洁的回答" },
      { section: "沟通偏好", text: "中文优先，术语保留英文原词" },
      { section: "工作习惯", text: "先给结论再给理由" },
    ]);
  });

  it("keeps bullets written above the first section", () => {
    expect(parseEntryMemoryLines("- 裸条目\n\n## 小节\n- 有节的")).toEqual([
      { section: null, text: "裸条目" },
      { section: "小节", text: "有节的" },
    ]);
  });

  it("leaves an unclosed frontmatter fence alone instead of guess-repairing", () => {
    // Same rule as the server's strip_entry_frontmatter: no auto-repair. The `apply:`
    // line is not a bullet, so nothing bogus enters the list either way.
    expect(parseEntryMemoryLines("---\napply: always\n- 仍然算一条")).toEqual([
      { section: null, text: "仍然算一条" },
    ]);
  });

  it("yields nothing for free-form or empty entries so callers cannot invent a count", () => {
    expect(parseEntryMemoryLines("")).toEqual([]);
    expect(parseEntryMemoryLines("# 标题\n> 说明\n")).toEqual([]);
    expect(parseEntryMemoryLines("这是一段没有 bullet 的散文规则。")).toEqual(
      [],
    );
    expect(parseEntryMemoryLines("## 小节\n-   \n")).toEqual([]);
  });

  it("accepts * and + markers and CRLF bodies", () => {
    expect(parseEntryMemoryLines("* 星号\r\n+ 加号\r\n")).toEqual([
      { section: null, text: "星号" },
      { section: null, text: "加号" },
    ]);
  });
});
