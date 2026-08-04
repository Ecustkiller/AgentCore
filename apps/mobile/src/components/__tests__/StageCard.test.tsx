import { StageCard } from "@/components/StageCard";
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/** jsdom 无 showModal；与 ModelPicker / BrowserLiveSheet 同桩。 */
vi.mock("@/components/Modal", () => ({
  Modal: ({
    children,
    className,
    label,
  }: {
    children: ReactNode;
    className?: string;
    label?: string;
  }) => (
    <dialog className={className} aria-label={label}>
      {children}
    </dialog>
  ),
}));

const pendingCard = {
  kind: "stage_card" as const,
  id: "sc_1",
  status: "pending" as const,
  motion: "是否应开辩",
  sides: [
    { key: "pro", name: "正方", stance: "应开" },
    { key: "con", name: "反方", stance: "暂缓" },
  ],
  form: "debate",
  rationale: "真对立轴",
  factPointers: [],
  thorough: true,
  maxRounds: 5,
  note: null,
};

describe("StageCard (mobile)", () => {
  it("pending opens sheet with CTAs; latch appears only after collapse", () => {
    const onResolve = vi.fn();
    render(<StageCard card={pendingCard} onResolve={onResolve} />);
    expect(screen.queryByTestId("stage-card-latch")).toBeNull();
    expect(screen.getByTestId("stage-card")).toBeTruthy();
    expect(screen.getAllByText("下一步 · 开辩").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getByText("是否应开辩")).toBeTruthy();
    expect(screen.getByText("按此开辩")).toBeTruthy();
    expect(screen.getByText("先补充调研")).toBeTruthy();
    expect(screen.getByText("调整命题")).toBeTruthy();
  });

  it("collapse hides sheet CTAs but latch remains", () => {
    render(<StageCard card={pendingCard} onResolve={vi.fn()} />);
    expect(screen.getByText("按此开辩")).toBeTruthy();
    fireEvent.click(screen.getByTestId("interaction-sheet-collapse"));
    expect(screen.queryByText("按此开辩")).toBeNull();
    expect(screen.getByTestId("stage-card-latch")).toBeTruthy();
    expect(screen.getByText("是否应开辩 · 开辩")).toBeTruthy();
  });

  it("shows orphaned hint aligned with desktop copy, without actions", () => {
    render(
      <StageCard
        card={{
          kind: "stage_card",
          id: "sc_1",
          status: "orphaned",
          motion: "x",
          sides: [],
          form: "debate",
          rationale: "",
          factPointers: [],
          thorough: true,
          maxRounds: 5,
          note: null,
        }}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText("阶段推进卡已失效")).toBeTruthy();
    expect(screen.getByText(/开辩入口不再可用/)).toBeTruthy();
    expect(screen.queryByText("按此开辩")).toBeNull();
  });

  it("shows resolved copy without action buttons", () => {
    render(
      <StageCard
        card={{
          kind: "stage_card",
          id: "sc_1",
          status: "resolved",
          motion: "x",
          sides: [],
          form: "debate",
          rationale: "",
          factPointers: [],
          thorough: true,
          maxRounds: 5,
          note: null,
        }}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText("已按此开辩")).toBeTruthy();
    expect(screen.queryByText("按此开辩")).toBeNull();
    expect(screen.queryByText("先补充调研")).toBeNull();
    expect(screen.queryByText("调整命题")).toBeNull();
  });
});
