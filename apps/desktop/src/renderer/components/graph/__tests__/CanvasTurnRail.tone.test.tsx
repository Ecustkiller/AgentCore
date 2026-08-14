// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasTurnRail, type TurnRailItem } from "../CanvasTurnRail";

afterEach(cleanup);

function pad(head: TurnRailItem): TurnRailItem[] {
  const rest: TurnRailItem[] = Array.from({ length: 4 }, (_, i) => ({
    id: `pad-${i}`,
    kind: "simple",
    status: "completed",
    running: false,
    pendingDecisions: 0,
    label: `pad-${i}`,
  }));
  return [head, ...rest];
}

function renderRail(head: Partial<TurnRailItem> & Pick<TurnRailItem, "label">) {
  const item: TurnRailItem = {
    id: "t0",
    kind: "team",
    status: "completed",
    running: false,
    pendingDecisions: 0,
    ...head,
  };
  return render(
    <CanvasTurnRail items={pad(item)} focusedId={null} onSelect={vi.fn()} />,
  );
}

function headDot(): HTMLElement {
  const btn = screen.getByRole("button", { name: /^回合 1：/ });
  return btn.querySelector("span") as HTMLElement;
}

describe("CanvasTurnRail tone", () => {
  it("paints a pending-decision tick primary (outranks failed)", () => {
    renderRail({
      label: "拍板",
      pendingDecisions: 1,
      status: "failed",
    });
    const dot = headDot();
    expect(dot.className).toContain("bg-primary");
    expect(dot.className).not.toContain("bg-destructive");
  });

  it("paints a running tick primary", () => {
    renderRail({ label: "进行中", running: true, status: "running" });
    expect(headDot().className).toContain("bg-primary");
  });

  it("paints a completed tick success (including a finished partial-fail turn)", () => {
    renderRail({ label: "完成", status: "completed" });
    const dot = headDot();
    expect(dot.className).toContain("bg-success");
    expect(dot.className).not.toContain("bg-destructive");
    expect(dot.className).not.toContain("bg-primary");
  });

  it("paints a failed tick destructive", () => {
    renderRail({ label: "失败", status: "failed" });
    expect(headDot().className).toContain("bg-destructive");
  });
});
