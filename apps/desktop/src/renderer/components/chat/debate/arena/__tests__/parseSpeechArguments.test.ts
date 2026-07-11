import { describe, expect, it } from "vitest";
import {
  argumentTitle,
  parseSpeechArguments,
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

  it("strips clear opening preamble before real arguments", () => {
    const args = parseSpeechArguments(
      "以下是正方的立论。\n\n成本可控，回收周期短。\n\n风险有明确兜底。",
    );
    expect(args).toHaveLength(2);
    expect(args[0].body).toContain("成本可控");
    expect(args.every((a) => !a.body.includes("以下是"))).toBe(true);
  });

  it("strips meta info-ready preamble", () => {
    const args = parseSpeechArguments(
      "现在我已有足够信息来构建论点。\n\n收益可量化。\n\n迁移路径清晰。",
    );
    expect(args).toHaveLength(2);
    expect(args[0].body).toContain("收益");
  });

  it("strips catalog-style preamble", () => {
    const args = parseSpeechArguments(
      "接下来我将从以下几个方面阐述。\n\n第一点：成本。\n\n第二点：风险。",
    );
    expect(args).toHaveLength(2);
    expect(args[0].body).toContain("成本");
  });

  it("keeps ambiguous first block that looks like a real argument", () => {
    const args = parseSpeechArguments(
      "首先成本是可控的，因为规模效应明显。\n\n其次风险有兜底。",
    );
    expect(args).toHaveLength(2);
    expect(args[0].body).toContain("成本是可控的");
  });

  it("falls back when preamble is the only block", () => {
    const text = "以下是正方的立论。";
    const args = parseSpeechArguments(text);
    expect(args).toHaveLength(1);
    expect(args[0].body).toBe(text);
  });
});
