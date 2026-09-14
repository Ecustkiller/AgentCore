// @vitest-environment jsdom
import { RunConfirmPrompt } from "@/components/chat/RunConfirmPrompt";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRunConfirmStore } from "@/stores/runConfirm";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
  useRunConfirmStore.getState().reset();
});

describe("RunConfirmPrompt", () => {
  it("renders nothing when idle", () => {
    render(
      <TooltipProvider>
        <RunConfirmPrompt />
      </TooltipProvider>,
    );
    expect(screen.queryByText("在终端运行")).toBeNull();
  });

  it("uses the same decision-card chrome as approval", () => {
    useRunConfirmStore.setState({ pending: { command: "ls -la" } });
    render(
      <TooltipProvider>
        <RunConfirmPrompt />
      </TooltipProvider>,
    );
    expect(screen.getByText("请求执行")).toBeTruthy();
    expect(screen.getByText("在终端运行")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" }).className).toContain(
      "border-border",
    );
    expect(screen.getByRole("button", { name: "运行" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "本会话都允许" }).className,
    ).toContain("border-border");
  });
});
