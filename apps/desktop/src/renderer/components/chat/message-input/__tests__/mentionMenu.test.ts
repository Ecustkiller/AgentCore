import { describe, expect, it } from "vitest";
import {
  parseMentionFilter,
  pickRecentConversations,
} from "../composerAttachments";

describe("parseMentionFilter", () => {
  it("returns null section when no type prefix", () => {
    expect(parseMentionFilter("readme")).toEqual({
      section: null,
      filter: "readme",
    });
    expect(parseMentionFilter("")).toEqual({ section: null, filter: "" });
  });

  it("strips Chinese type prefixes", () => {
    expect(parseMentionFilter("团队")).toEqual({
      section: "team",
      filter: "",
    });
    expect(parseMentionFilter("对话 foo")).toEqual({
      section: "conversation",
      filter: "foo",
    });
    expect(parseMentionFilter("文件夹 src")).toEqual({
      section: "folder",
      filter: "src",
    });
    expect(parseMentionFilter("文件 a.ts")).toEqual({
      section: "file",
      filter: "a.ts",
    });
  });

  it("strips English prefixes case-insensitively", () => {
    expect(parseMentionFilter("Agent")).toEqual({
      section: "team",
      filter: "",
    });
    expect(parseMentionFilter("conv hello")).toEqual({
      section: "conversation",
      filter: "hello",
    });
    expect(parseMentionFilter("DIR lib")).toEqual({
      section: "folder",
      filter: "lib",
    });
    expect(parseMentionFilter("file x")).toEqual({
      section: "file",
      filter: "x",
    });
  });

  it("prefers 文件夹 over 文件", () => {
    expect(parseMentionFilter("文件夹")).toEqual({
      section: "folder",
      filter: "",
    });
  });
});

describe("pickRecentConversations", () => {
  const list = [
    { id: "c1", title: "当前会话" },
    { id: "c2", title: "昨日讨论" },
    { id: "c3", title: "设计评审" },
    { id: "c4", title: "无关" },
  ];

  it("excludes current conversation and limits", () => {
    const items = pickRecentConversations(list, "c1", "", 2);
    expect(items.map((i) => i.relPath)).toEqual(["c2", "c3"]);
    expect(items.every((i) => i.kind === "conversation")).toBe(true);
  });

  it("filters by title substring", () => {
    const items = pickRecentConversations(list, null, "设计");
    expect(items.map((i) => i.relPath)).toEqual(["c3"]);
  });
});
