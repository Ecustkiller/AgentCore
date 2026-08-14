// @vitest-environment jsdom
import { Button } from "@/components/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsAsync } from "../SettingsAsync";

describe("SettingsAsync", () => {
  it("renders children once there is something to show", () => {
    render(
      <SettingsAsync>
        <p>已配置</p>
      </SettingsAsync>,
    );
    expect(screen.getByText("已配置")).toBeTruthy();
    expect(screen.queryByText("加载中…")).toBeNull();
  });

  it("shows a spinner line while loading, never the children", () => {
    const { container } = render(
      <SettingsAsync loading>
        <p>已配置</p>
      </SettingsAsync>,
    );
    expect(screen.getByText("加载中…")).toBeTruthy();
    expect(screen.queryByText("已配置")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("takes a custom loading label", () => {
    render(<SettingsAsync loading loadingLabel="加载组合…" />);
    expect(screen.getByText("加载组合…")).toBeTruthy();
  });

  it("keeps error distinct from empty and offers a retry", () => {
    const onRetry = vi.fn();
    render(
      <SettingsAsync error="加载失败，请重试" empty onRetry={onRetry}>
        <p>已配置</p>
      </SettingsAsync>,
    );
    expect(screen.getByText("加载失败，请重试").className).toContain(
      "text-muted-foreground",
    );
    expect(screen.queryByText("暂无内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button when the caller has no retry", () => {
    render(<SettingsAsync error="无法加载凭据状态" />);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("shows the empty label plus an optional CTA", () => {
    render(
      <SettingsAsync
        empty
        emptyLabel="还没有接入服务商。"
        emptyAction={<Button>添加服务商</Button>}
      >
        <p>列表</p>
      </SettingsAsync>,
    );
    expect(screen.getByText("还没有接入服务商。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加服务商" })).toBeTruthy();
    expect(screen.queryByText("列表")).toBeNull();
  });

  it("card variant renders the dashed first-load panel", () => {
    const { container } = render(
      <SettingsAsync variant="card" error="用量加载失败" onRetry={() => {}} />,
    );
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain("border-dashed");
    expect(panel.className).toContain("rounded-xl");
    expect(panel.className).toContain("text-center");
  });

  it("sm size drops to caption type for nested blocks", () => {
    render(<SettingsAsync empty size="sm" emptyLabel="暂无组合" />);
    expect(screen.getByText("暂无组合").className).toContain("text-xs");
  });
});
