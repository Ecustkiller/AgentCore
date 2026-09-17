import {
  cleanSourceTitle,
  inlineSourceLabel,
  referencedCitationNumbers,
  sourceTitleAndSite,
  urlsPointSameSource,
} from "@/lib/citations";
import { describe, expect, it } from "vitest";

describe("cleanSourceTitle", () => {
  it("strips a space-padded dash site suffix", () => {
    expect(cleanSourceTitle("深圳天气预报 - 中国天气网")).toBe("深圳天气预报");
  });

  it("strips an unspaced CJK underscore suffix", () => {
    expect(cleanSourceTitle("相对论_百度百科")).toBe("相对论");
  });

  it("strips an English ' - ' site suffix", () => {
    expect(cleanSourceTitle("OpenAI Charter - Wikipedia")).toBe(
      "OpenAI Charter",
    );
  });

  it("keeps titles where a dash is part of the content", () => {
    expect(cleanSourceTitle("2024-2025 年度财政预算报告")).toBe(
      "2024-2025 年度财政预算报告",
    );
  });

  it("leaves short titles untouched", () => {
    expect(cleanSourceTitle("百度百科")).toBe("百度百科");
  });

  it("handles undefined and blank input", () => {
    expect(cleanSourceTitle(undefined)).toBe("");
    expect(cleanSourceTitle("   ")).toBe("");
  });
});

describe("sourceTitleAndSite", () => {
  it("joins title · site and omits site when it equals the title", () => {
    expect(
      sourceTitleAndSite({
        title: "OpenAI Charter - Wikipedia",
        site: "en.wikipedia.org",
        url: "https://en.wikipedia.org/wiki/OpenAI",
      }),
    ).toEqual({ title: "OpenAI Charter", site: "en.wikipedia.org" });
    expect(
      sourceTitleAndSite({
        title: "anthropic.com",
        site: "anthropic.com",
        url: "https://anthropic.com",
      }),
    ).toEqual({ title: "anthropic.com", site: undefined });
  });
});

describe("inlineSourceLabel", () => {
  it("prefers site over page title so a long <title> cannot break the sentence", () => {
    expect(
      inlineSourceLabel({
        title: "OpenAI Charter - Wikipedia",
        site: "en.wikipedia.org",
        url: "https://en.wikipedia.org/wiki/OpenAI",
      }),
    ).toBe("en.wikipedia.org");
  });

  it("falls back to host when site is empty", () => {
    expect(
      inlineSourceLabel({
        title: "unused title",
        site: "",
        url: "https://www.example.com/path",
      }),
    ).toBe("example.com");
  });

  it("falls back to 来源 when nothing resolvable", () => {
    expect(inlineSourceLabel({ title: "only a title" })).toBe("来源");
  });
});

describe("urlsPointSameSource", () => {
  it("treats www, trailing slash, and hash as the same page", () => {
    expect(
      urlsPointSameSource(
        "https://www.Example.com/a/",
        "https://example.com/a#section",
      ),
    ).toBe(true);
  });

  it("keeps query strings distinct", () => {
    expect(
      urlsPointSameSource(
        "https://example.com/a?q=1",
        "https://example.com/a?q=2",
      ),
    ).toBe(false);
  });
});

describe("referencedCitationNumbers", () => {
  it("collects in-range [n] markers in body order", () => {
    expect([...referencedCitationNumbers("see [1] and [3].", 5)]).toEqual([
      1, 3,
    ]);
  });

  it("ignores zero and out-of-range markers", () => {
    expect([...referencedCitationNumbers("[0] [3] [9]", 3)]).toEqual([3]);
  });

  it("dedups repeated markers", () => {
    expect([...referencedCitationNumbers("[2] x [2] y [2]", 3)]).toEqual([2]);
  });

  it("is empty when max is 0 or content is empty", () => {
    expect(referencedCitationNumbers("[1]", 0).size).toBe(0);
    expect(referencedCitationNumbers("", 5).size).toBe(0);
  });
});
