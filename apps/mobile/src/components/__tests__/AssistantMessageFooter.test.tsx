// @vitest-environment jsdom
import {
  AssistantMessageFooter,
  DeliveryShortfallHint,
  FinishReasonChip,
} from "@/components/AssistantMessageFooter";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/InteractionSheet", () => ({
  InteractionSheet: ({
    title,
    children,
    onCollapse,
    footer,
  }: {
    title: string;
    children: React.ReactNode;
    onCollapse: () => void;
    footer: React.ReactNode;
  }) => (
    <div data-testid="interaction-sheet" data-title={title}>
      {children}
      <div>{footer}</div>
      <button type="button" onClick={onCollapse}>
        close-mock
      </button>
    </div>
  ),
}));

afterEach(cleanup);

describe("FinishReasonChip", () => {
  it("renders abnormal finish reasons", () => {
    render(<FinishReasonChip reason="degraded" />);
    expect(screen.getByTestId("finish-reason-chip").textContent).toContain(
      "降级完成",
    );
  });

  it("uses diagnosis label for degraded", () => {
    render(
      <FinishReasonChip reason="degraded" diagnosisLabel="模型返回空内容" />,
    );
    expect(screen.getByTestId("finish-reason-chip").textContent).toBe(
      "降级完成 · 模型返回空内容",
    );
  });

  it("hides normal finishes", () => {
    const { container } = render(<FinishReasonChip reason="end_turn" />);
    expect(container.textContent).toBe("");
  });
});

describe("DeliveryShortfallHint", () => {
  it("shows partial/blocked only", () => {
    const { rerender } = render(
      <DeliveryShortfallHint
        status={{ state: "partial", summary: "缺一份报告" }}
      />,
    );
    expect(screen.getByTestId("delivery-shortfall-hint").textContent).toBe(
      "缺一份报告",
    );
    rerender(
      <DeliveryShortfallHint status={{ state: "delivered", summary: "ok" }} />,
    );
    expect(screen.queryByTestId("delivery-shortfall-hint")).toBeNull();
  });
});

describe("AssistantMessageFooter", () => {
  it("exposes copy deliverable + with_process when process exists", () => {
    render(
      <AssistantMessageFooter
        content="答案"
        process={[
          {
            kind: "tool",
            id: "t1",
            tool_name: "web_search",
            arguments: {},
            result: null,
            status: "success",
          },
        ]}
        usage={{
          input: 1200,
          output: 300,
          reasoning: 0,
          cache_hit: 0,
          cache_miss: 1200,
        }}
        costText="¥0.01"
        durationMs={45000}
      />,
    );
    expect(screen.getByText("复制交付")).toBeTruthy();
    expect(screen.getByText("含过程")).toBeTruthy();
    expect(screen.getByTestId("assistant-usage-summary").textContent).toContain(
      "↑1.2k",
    );
    expect(screen.getByTestId("assistant-usage-summary").textContent).toContain(
      "¥0.01",
    );
    expect(screen.getByTestId("assistant-usage-summary").textContent).toContain(
      "用时 45s",
    );
  });

  it("opens Sheet for usage detail via 更多", () => {
    render(
      <AssistantMessageFooter
        content="答案"
        usage={{
          input: 100,
          output: 50,
          reasoning: 10,
          cache_hit: 20,
          cache_miss: 80,
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("assistant-footer-more"));
    expect(screen.getByTestId("interaction-sheet")).toBeTruthy();
    expect(screen.getByText("用量详情")).toBeTruthy();
    expect(screen.getByText("思考")).toBeTruthy();
  });

  it("streaming footer is copy-only", () => {
    render(<AssistantMessageFooter content="streaming…" isStreaming />);
    expect(screen.getByText("复制交付")).toBeTruthy();
    expect(screen.queryByTestId("assistant-usage-summary")).toBeNull();
    expect(screen.queryByTestId("assistant-footer-more")).toBeNull();
  });
});
