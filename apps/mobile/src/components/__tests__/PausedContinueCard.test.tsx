// @vitest-environment jsdom
import { PausedContinueCard } from "@/components/PausedContinueCard";
import { PAUSED_VERDICT } from "@/lib/turnOutcome";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
});

describe("PausedContinueCard", () => {
  it("shows one verdict and one continue action; rate-limit copy is the reason", () => {
    const onContinue = vi.fn();
    render(
      <PausedContinueCard
        reason="上游限流，暂时无法继续本回合。请约 4 秒后再试。"
        onContinue={onContinue}
      />,
    );
    expect(
      screen.getByTestId("paused-continue").getAttribute("data-kind"),
    ).toBe("paused");
    expect(screen.getByText(PAUSED_VERDICT)).toBeTruthy();
    expect(
      screen.getByText("上游限流，暂时无法继续本回合。请约 4 秒后再试。"),
    ).toBeTruthy();
    expect(screen.queryByText("重试")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("omits the action when continue is not provided", () => {
    render(<PausedContinueCard reason="上游限流" />);
    expect(screen.getByText(PAUSED_VERDICT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
  });

  it("unlocks after onContinue rejects so the user can retry", async () => {
    const onContinue = vi.fn().mockRejectedValue(new Error("连接中断，请重试"));
    render(<PausedContinueCard reason="上游限流" onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByText("连接中断，请重试")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "继续" });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the action busy after a successful continue until unmount", async () => {
    const onContinue = vi.fn().mockResolvedValue(undefined);
    render(<PausedContinueCard reason="上游限流" onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    const btn = await screen.findByRole("button", { name: "继续中…" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
