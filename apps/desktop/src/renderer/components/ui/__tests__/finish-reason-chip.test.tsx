// @vitest-environment jsdom
import { FinishReasonChip, FINISH_REASON_META } from "@/components/ui/finish-reason-chip";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
});

describe("FinishReasonChip", () => {
  it("degraded default label is 空响应收尾", () => {
    render(<FinishReasonChip reason="degraded" />);
    expect(screen.getByText("空响应收尾")).toBeTruthy();
    expect(screen.queryByText(/降级完成/)).toBeNull();
    expect(FINISH_REASON_META.degraded.label).toBe("空响应收尾");
  });

  it("degraded with diagnosis shows diagnosis only (no 降级完成 prefix)", () => {
    render(
      <FinishReasonChip
        reason="degraded"
        diagnosisLabel="上游返回了网页或登录页，请检查服务商地址与鉴权"
      />,
    );
    expect(
      screen.getByText("上游返回了网页或登录页，请检查服务商地址与鉴权"),
    ).toBeTruthy();
    expect(screen.queryByText(/降级完成/)).toBeNull();
    expect(screen.queryByText("空响应收尾")).toBeNull();
  });
});
