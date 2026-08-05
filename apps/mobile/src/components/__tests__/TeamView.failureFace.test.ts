/**
 * failureFaceLabel：协作图失败脸按 failureKind 贴文案（禁扫正文猜脸）。
 * 对齐桌面 statusFace · format→「格式未过」。
 */
import { failureFaceLabel } from "@/components/TeamView";
import { describe, expect, it } from "vitest";

describe("failureFaceLabel", () => {
  it("maps failureKind=format to 格式未过", () => {
    expect(
      failureFaceLabel("结构闸：findings[0] severity 无效", "format"),
    ).toBe("格式未过");
  });

  it("prefers failureKind over error text", () => {
    expect(failureFaceLabel("未通过契约：缺少引用", "format")).toBe("格式未过");
    expect(failureFaceLabel("结构闸", "quality")).toBe("未达标");
  });

  it("maps other kinds and productLanded", () => {
    expect(failureFaceLabel(null, "quality")).toBe("未达标");
    expect(failureFaceLabel(null, "model")).toBe("模型中断");
    expect(failureFaceLabel(null, "call")).toBe("调用失败");
    expect(failureFaceLabel("任意", "format", true)).toBe("产出已落盘");
  });
});
