// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceChannelGuideDialog } from "../WorkspaceChannelGuideDialog";

afterEach(() => {
  cleanup();
});

describe("WorkspaceChannelGuideDialog", () => {
  it("shows cloud + local sections on desktop", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional
      />,
    );
    expect(screen.getByText("在哪工作：怎么选")).toBeTruthy();
    expect(screen.getByText("云协作")).toBeTruthy();
    expect(screen.getByText("推荐")).toBeTruthy();
    expect(screen.getByText("本机传统")).toBeTruthy();
    expect(screen.getByText(/不是离线模式/)).toBeTruthy();
    expect(screen.getByText(/选过的通道会记住/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
  });

  it("hides local traditional when no local disk", () => {
    render(
      <WorkspaceChannelGuideDialog
        open
        onOpenChange={() => {}}
        showLocalTraditional={false}
      />,
    );
    expect(screen.getByText("云协作")).toBeTruthy();
    expect(screen.getByText("推荐")).toBeTruthy();
    expect(screen.queryByText("本机传统")).toBeNull();
  });
});
