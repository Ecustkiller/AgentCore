// @vitest-environment jsdom
import {
  RECONNECTING_BANNER,
  RECONNECT_INTERRUPTED_BANNER,
} from "@/services/turns/helpers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerFailureBanner } from "../ComposerFailureBanner";

afterEach(cleanup);

function renderBanner(
  props: Partial<ComponentProps<typeof ComposerFailureBanner>> & {
    message: string;
  },
) {
  const onDismiss = props.onDismiss ?? vi.fn();
  render(
    <MemoryRouter>
      <ComposerFailureBanner
        action={props.action ?? null}
        onDismiss={onDismiss}
        message={props.message}
      />
    </MemoryRouter>,
  );
  return { onDismiss };
}

describe("ComposerFailureBanner", () => {
  it("uses neutral chrome without a config action", () => {
    renderBanner({
      message: "上游限流，暂时无法继续本回合。请约 2 秒后再试。",
    });
    const banner = screen.getByTestId("composer-failure-banner");
    expect(banner.className).toContain("bg-muted/40");
    expect(banner.className).not.toContain("destructive");
    expect(banner.getAttribute("data-banner-tone")).toBe("alert");
  });

  it("uses notice chrome for a quiet reconnect line", () => {
    renderBanner({ message: RECONNECTING_BANNER });
    const banner = screen.getByTestId("composer-failure-banner");
    expect(banner.getAttribute("data-banner-tone")).toBe("notice");
    expect(banner.className).toContain("bg-muted/40");
  });

  it("uses alert chrome for an interrupted reconnect line", () => {
    renderBanner({ message: RECONNECT_INTERRUPTED_BANNER });
    expect(
      screen
        .getByTestId("composer-failure-banner")
        .getAttribute("data-banner-tone"),
    ).toBe("alert");
  });

  it("uses primary chrome when a config action is offered", () => {
    renderBanner({
      message: "请先接入自己的 API Key，再发起对话。",
      action: { label: "去服务商", href: "/more/providers" },
    });
    const banner = screen.getByTestId("composer-failure-banner");
    expect(banner.className).toContain("bg-primary/10");
    expect(banner.className).not.toContain("destructive");
    expect(screen.getByRole("button", { name: "去服务商" })).toBeTruthy();
  });

  it("close calls onDismiss", () => {
    const { onDismiss } = renderBanner({ message: "发送失败，请稍后重试" });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not offer 复制排查包", () => {
    renderBanner({ message: "发送失败，请稍后重试" });
    expect(screen.queryByRole("button", { name: "复制排查包" })).toBeNull();
  });
});
