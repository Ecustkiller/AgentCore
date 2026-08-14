import {
  buildDirListing,
  buildMentionCategoryRows,
  detectMention,
  formatConversationContext,
  isInternalZonePath,
  parseMentionFilter,
  pickRecentConversations,
  showMentionCategoryLevel,
} from "@/lib/composerMention";
import { describe, expect, it } from "vitest";

describe("detectMention", () => {
  it("opens after a leading or spaced @", () => {
    expect(detectMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(detectMention("看 @文件", 5)).toEqual({ start: 2, query: "文件" });
  });

  it("ignores email-like @", () => {
    expect(detectMention("a@b", 3)).toBeNull();
  });
});

describe("parseMentionFilter", () => {
  it("recognizes type prefixes", () => {
    expect(parseMentionFilter("文件 foo")).toEqual({
      section: "file",
      filter: "foo",
    });
    expect(parseMentionFilter("团队")).toEqual({
      section: "team",
      filter: "",
    });
    expect(parseMentionFilter("bar")).toEqual({
      section: null,
      filter: "bar",
    });
  });
});

describe("showMentionCategoryLevel / buildMentionCategoryRows", () => {
  it("stays on categories when query is empty", () => {
    expect(
      showMentionCategoryLevel({
        sectionFilter: null,
        activeCategory: null,
        filterText: "",
      }),
    ).toBe(true);
    const rows = buildMentionCategoryRows({
      counts: { team: 0, conversation: 0, folder: 0, file: 0 },
    });
    expect(rows[0]?.id).toBe("attach");
    expect(rows[0]?.hint).toBe("从本机添加");
    expect(rows.find((r) => r.id === "team")?.hint).toBe(
      "多 Agent 回合后可点名",
    );
  });
});

describe("pickRecentConversations / formatConversationContext", () => {
  it("excludes current chat and formats recent turns", () => {
    expect(
      pickRecentConversations(
        [
          { id: "here", title: "当前" },
          { id: "c2", title: "其他" },
        ],
        "here",
        "",
      ),
    ).toEqual([{ id: "c2", title: "其他" }]);
    const ctx = formatConversationContext([
      { role: "user", content: "问" },
      { role: "assistant", content: "答" },
    ]);
    expect(ctx.text).toContain("用户: 问");
    expect(ctx.text).toContain("助手: 答");
    expect(ctx.truncated).toBe(false);
  });
});

describe("buildDirListing / isInternalZonePath", () => {
  it("lists files under a prefix and hides internal zones", () => {
    expect(isInternalZonePath("AgentCore/trash/x")).toBe(true);
    expect(isInternalZonePath("src/a.ts")).toBe(false);
    const listing = buildDirListing(["src/a.ts", "src/b.ts"], {
      name: "src",
      display: "src",
      prefix: "src",
    });
    expect(listing.fileCount).toBe(2);
    expect(listing.text).toContain("a.ts");
  });
});
