import { describe, expect, it } from "vitest";
import {
  buildCrossExamExchanges,
  parseCrossExamResponse,
} from "../crossExamParse";

describe("parseCrossExamResponse", () => {
  it("parses structured JSON array by question_index", () => {
    const qs = [
      "收益量化口径是否计入了尾部风险？请是/否直接回答。",
      "若熔断触发、灰度止损，已投入成本由谁承担？",
    ];
    const payload = [
      {
        question_index: 1,
        answer: "否，量化口径未含尾部风险【待核实·推断】。",
        directly_addressed: true,
      },
      {
        question_index: 2,
        answer: "成本由灰度预算池兜底、触发熔断即回滚【已核实·灰度预案v2】",
        directly_addressed: true,
      },
    ];
    const got = parseCrossExamResponse(qs, JSON.stringify(payload));
    expect(got).toHaveLength(2);
    expect(got[0].answer).toContain("尾部");
    expect(got[0].ok).toBe(true);
    expect(got[1].answer).toContain("灰度");
    expect(got[1].ok).toBe(true);
  });

  it("parses JSON inside markdown fence", () => {
    const qs = ["你这条有出处吗？"];
    const raw =
      "说明：以下是我的回答\n```json\n" +
      JSON.stringify([
        {
          question_index: 1,
          answer: "暂无统一出处【待核实·推断】",
          directly_addressed: false,
        },
      ]) +
      "\n```";
    const got = parseCrossExamResponse(qs, raw);
    expect(got).toHaveLength(1);
    expect(got[0].ok).toBe(false);
    expect(got[0].answer).toContain("出处");
  });

  it("falls back to heuristic blob split when JSON absent", () => {
    const qs = ["收益是否计入尾部风险？"];
    const ans = "作答：否，口径未含尾部【待核实·推断】。";
    const got = parseCrossExamResponse(qs, ans);
    expect(got).toHaveLength(1);
    expect(got[0].answer).toContain("尾部");
    expect(got[0].ok).toBe(true);
  });
});

describe("buildCrossExamExchanges (deprecated fallback)", () => {
  it("splits multi-question blob by semicolon", () => {
    const qs = [
      "收益量化口径是否计入了尾部风险？请是/否直接回答。",
      "若熔断触发、灰度止损，已投入成本由谁承担？",
    ];
    const ans =
      "量化口径未含尾部风险【待核实·推断】；" +
      "成本由灰度预算池兜底、触发熔断即回滚【已核实·灰度预案v2】";
    const got = buildCrossExamExchanges(qs, ans);
    expect(got).toHaveLength(2);
    expect(got[0].answer).toContain("尾部");
    expect(got[1].answer).toContain("灰度");
  });
});
