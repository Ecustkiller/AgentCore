// @vitest-environment jsdom
/**
 * Shared pager. Four hand-rolled variants used to disagree on when to show anything;
 * two of them hid the result count entirely whenever everything fit on one page.
 */

import { Pagination } from "@/components/ui/Pagination";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

describe("Pagination", () => {
  it("always reports the total, even when there is only one page", () => {
    render(<Pagination page={1} pageSize={50} total={7} onPageChange={vi.fn()} />);

    expect(screen.getByText("第 1–7 条 · 共 7 条")).toBeTruthy();
    expect(screen.queryByLabelText("下一页")).toBeNull();
  });

  it("states plainly that there is nothing, instead of showing 1/1", () => {
    render(<Pagination page={1} pageSize={50} total={0} onPageChange={vi.fn()} />);
    expect(screen.getByText("共 0 条")).toBeTruthy();
  });

  it("shows the range for the current page and steps through", () => {
    const onPageChange = vi.fn();
    render(
      <Pagination page={3} pageSize={20} total={95} onPageChange={onPageChange} />,
    );

    expect(screen.getByText("第 41–60 条 · 共 95 条")).toBeTruthy();
    expect(screen.getByText("3 / 5")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("下一页"));
    expect(onPageChange).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByLabelText("上一页"));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("clamps a page that ran past the end of a shrunken result set", () => {
    render(<Pagination page={9} pageSize={20} total={45} onPageChange={vi.fn()} />);
    // 45 rows is 3 pages — the pager reports where the data actually ends.
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect((screen.getByLabelText("下一页") as HTMLButtonElement).disabled).toBe(true);
  });

  it("freezes both steppers while a fetch is in flight", () => {
    render(
      <Pagination page={2} pageSize={20} total={95} onPageChange={vi.fn()} disabled />,
    );
    expect((screen.getByLabelText("上一页") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("下一页") as HTMLButtonElement).disabled).toBe(true);
  });
});
