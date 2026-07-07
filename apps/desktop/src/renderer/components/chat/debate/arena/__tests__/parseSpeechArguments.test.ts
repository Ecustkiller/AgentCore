import { describe, expect, it } from "vitest";
import {
  argumentTitle,
  parseSpeechArguments,
  sidePositionSummary,
  summarizeText,
} from "../parseSpeechArguments";

describe("summarizeText", () => {
  it("returns short text unchanged", () => {
    expect(summarizeText("短句", 30)).toBe("短句");
  });

  it("truncates long text with ellipsis", () => {
    const long = "这是一段很长的论述内容用于测试截断逻辑是否正常工作";
    const out = summarizeText(long, 12);
    expect(out.length).toBeLessThanOrEqual(13);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("argumentTitle", () => {
  it("extracts colon-prefixed label", () => {
    expect(
      argumentTitle(
        "支持理由：收益可量化——首年可降本约 18%，回收周期约两个季度。",
      ),
    ).toContain("支持理由");
  });

  it("uses first sentence for plain text", () => {
    expect(argumentTitle("第一点很重要。后面是补充。")).toBe("第一点很重要");
  });
});

describe("parseSpeechArguments", () => {
  it("parses numbered list", () => {
    const args = parseSpeechArguments(
      "1. 成本可控\n2. 风险有兜底\n3. 收益可量化",
    );
    expect(args).toHaveLength(3);
    expect(args[0].title).toContain("成本");
  });

  it("parses bullet list", () => {
    const args = parseSpeechArguments("- 论点甲\n- 论点乙");
    expect(args).toHaveLength(2);
  });

  it("parses markdown headers", () => {
    const args = parseSpeechArguments(
      "## 成本优势\n降本 18% 可核实。\n\n## 风险可控\n熔断兜底。",
    );
    expect(args).toHaveLength(2);
    expect(args[0].title).toContain("成本优势");
    expect(args[0].body).toContain("降本");
  });

  it("parses paragraph blocks", () => {
    const args = parseSpeechArguments("第一段立论。\n\n第二段补充。");
    expect(args).toHaveLength(2);
  });

  it("wraps single paragraph as one argument", () => {
    const text =
      "反对理由：风险缺兜底——迁移期存在双写不一致窗口，尾部故障率恐被低估。";
    const args = parseSpeechArguments(text);
    expect(args).toHaveLength(1);
    expect(args[0].body).toBe(text);
    expect(args[0].title).toContain("反对理由");
  });
});

describe("sidePositionSummary", () => {
  it("returns first argument title", () => {
    expect(
      sidePositionSummary("1. 收益显著\n2. 风险可控"),
    ).toContain("收益");
  });

  it("summarizes plain text when no structure", () => {
    const text = "这是一段没有明显结构的长篇立论内容需要被摘要";
    expect(sidePositionSummary(text, 10).length).toBeLessThanOrEqual(11);
  });
});
