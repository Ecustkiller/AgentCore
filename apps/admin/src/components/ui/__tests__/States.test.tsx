// @vitest-environment jsdom
/**
 * The four data states every list and dashboard shares. The interesting ones are
 * `Refreshing` (keep stale content usable instead of collapsing the page) and
 * `StaleDataNotice` (say out loud that the numbers on screen are no longer live).
 */

import {
  EmptyState,
  ErrorState,
  Refreshing,
  StaleDataNotice,
} from "@/components/ui/States";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

describe("StaleDataNotice", () => {
  it("announces itself, since it appears after the page has settled", () => {
    render(<StaleDataNotice message="网络错误" />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("网络错误");
    // Says the data is old, not merely that something failed — otherwise the numbers
    // behind the banner silently become a lie.
    expect(notice.textContent).toContain("上一次的数据");
  });

  it("offers a retry when the caller can reload", () => {
    const onRetry = vi.fn();
    render(<StaleDataNotice message="网络错误" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("Refreshing", () => {
  it("keeps content mounted and marks it busy while it reloads", () => {
    const { rerender } = render(
      <Refreshing active={false}>
        <p>三条记录</p>
      </Refreshing>,
    );
    expect(screen.getByText("三条记录")).toBeTruthy();

    rerender(
      <Refreshing active>
        <p>三条记录</p>
      </Refreshing>,
    );
    // Still on screen — collapsing to a spinner is what threw away scroll position.
    expect(screen.getByText("三条记录")).toBeTruthy();
    const region = screen.getByText("三条记录").parentElement;
    expect(region?.getAttribute("aria-busy")).toBe("true");
    expect(region?.className).toContain("pointer-events-none");
  });
});

describe("EmptyState / ErrorState", () => {
  it("states the empty case plainly and can offer a way out", () => {
    render(
      <EmptyState
        title="暂无审计记录"
        description="当前筛选下没有记录"
        action={<button type="button">清空筛选</button>}
      />,
    );
    expect(screen.getByText("暂无审计记录")).toBeTruthy();
    expect(screen.getByRole("button", { name: "清空筛选" })).toBeTruthy();
  });

  it("shows the failure with a retry", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="加载失败" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("omits the retry when there is nothing to retry with", () => {
    render(<ErrorState message="加载失败" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
