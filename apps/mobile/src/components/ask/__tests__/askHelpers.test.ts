import { composeAnswer } from "@/components/ask/composeAnswer";
import { parseRiskLabel } from "@/components/ask/parseRiskLabel";
import { describe, expect, it } from "vitest";

describe("parseRiskLabel", () => {
  it("parses [高]/[中]/[低] prefixes", () => {
    expect(parseRiskLabel("[高] 密钥轮换")).toEqual({
      severity: "high",
      text: "密钥轮换",
    });
    expect(parseRiskLabel("[中]备份校验")).toEqual({
      severity: "medium",
      text: "备份校验",
    });
    expect(parseRiskLabel("[低] 文档补齐")).toEqual({
      severity: "low",
      text: "文档补齐",
    });
  });

  it("plain label → no severity", () => {
    expect(parseRiskLabel("密钥轮换")).toEqual({
      severity: null,
      text: "密钥轮换",
    });
  });
});

describe("composeAnswer", () => {
  it("builds 答复模型 α from picks + note", () => {
    expect(
      composeAnswer(
        [{ id: "q0", prompt: "先做哪条", default: "方案 A" }],
        { q0: ["方案 A"] },
        {},
        {},
        "",
      ),
    ).toBe("我的答复：\n· 先做哪条：方案 A");
  });

  it("includes 其他 custom + 补充", () => {
    expect(
      composeAnswer(
        [{ id: "q0", prompt: "方向" }],
        { q0: [] },
        { q0: true },
        { q0: "自己写" },
        "再快点",
      ),
    ).toBe("我的答复：\n· 方向：自己写\n· 补充：再快点");
  });
});
