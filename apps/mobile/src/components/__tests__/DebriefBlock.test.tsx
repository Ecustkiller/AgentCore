// @vitest-environment jsdom

import { DebriefBlock } from "@/components/DebriefBlock";
import type { RunDebrief } from "@agentcore/protocol-conformance";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

const baseDebrief: RunDebrief = {
  summary: "交叉验证完成",
  key_points: ["共识：一周内需清晰立场"],
  assumptions: "争议事实以公开报道为准",
  next_steps: "若用户同意，建议开辩",
};

function expandDebrief(summary = "交叉验证完成") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(summary) }));
}

describe("DebriefBlock", () => {
  it("defaults to a collapsed relay card: summary visible, details hidden", () => {
    render(<DebriefBlock debrief={baseDebrief} />);
    expect(screen.getByText("交接简报")).toBeTruthy();
    expect(screen.getByText("交叉验证完成")).toBeTruthy();
    expect(screen.queryByText("结论")).toBeNull();
    expect(screen.queryByText("关键要点")).toBeNull();
    expect(screen.queryByText("关键假设")).toBeNull();
    expect(screen.queryByText("建议下一步")).toBeNull();
  });

  it("expands to show points / assumptions / next steps", () => {
    render(<DebriefBlock debrief={baseDebrief} />);
    expandDebrief();
    expect(screen.getByText("关键要点")).toBeTruthy();
    expect(screen.getByText("共识：一周内需清晰立场")).toBeTruthy();
    expect(screen.getByText("关键假设")).toBeTruthy();
    expect(screen.getByText("争议事实以公开报道为准")).toBeTruthy();
    expect(screen.getByText("建议下一步")).toBeTruthy();
    expect(screen.getByText("若用户同意，建议开辩")).toBeTruthy();
  });

  it("degraded brief shows a notice and hides the body slice", () => {
    const degraded = {
      ...baseDebrief,
      degraded: true,
    } as RunDebrief;
    render(<DebriefBlock debrief={degraded} />);
    expect(screen.getByText("简报由系统降级生成")).toBeTruthy();
    expect(screen.queryByText("交叉验证完成")).toBeNull();
    expect(screen.queryByText("关键要点")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("summary-only brief stays a one-line card without a toggle", () => {
    render(<DebriefBlock debrief={{ summary: "只写了结论" }} />);
    expect(screen.getByText("只写了结论")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
