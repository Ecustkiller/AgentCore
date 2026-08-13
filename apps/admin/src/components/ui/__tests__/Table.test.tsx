// @vitest-environment jsdom
/**
 * Table primitives. The load-bearing bit is `TableRow`'s activation contract: 点行进复盘
 * is the console's main drill-in, and it used to be mouse-only across every list page.
 */

import {
  TableFrame,
  TableMessageRow,
  TableRow,
  THead,
  Td,
  Th,
} from "@/components/ui/Table";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function renderRow(onActivate?: () => void) {
  return render(
    <TableFrame minWidth={600}>
      <THead>
        <Th>用户</Th>
        <Th align="right">成本</Th>
      </THead>
      <tbody>
        <TableRow onActivate={onActivate} label="打开 alice 的会话">
          <Td>alice</Td>
          <Td align="right">
            <button type="button">复制</button>
          </Td>
        </TableRow>
      </tbody>
    </TableFrame>,
  );
}

describe("TableRow", () => {
  it("stays a plain row when it has no activation", () => {
    renderRow();
    const row = screen.getByRole("row", { name: /alice/ });
    expect(row.getAttribute("tabindex")).toBeNull();
  });

  it("activates on click and on Enter/Space when focusable", () => {
    const onActivate = vi.fn();
    renderRow(onActivate);
    const row = screen.getByRole("row", { name: "打开 alice 的会话" });

    expect(row.getAttribute("tabindex")).toBe("0");

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it("ignores keys aimed at a control inside the row", () => {
    const onActivate = vi.fn();
    renderRow(onActivate);

    fireEvent.keyDown(screen.getByRole("button", { name: "复制" }), { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("keeps native row semantics rather than posing as a link", () => {
    renderRow(vi.fn());
    // `role="link"` on a <tr> would drop the row out of the table for screen readers.
    expect(screen.getByRole("row", { name: "打开 alice 的会话" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("TableFrame", () => {
  it("scrolls rather than clipping when the columns do not fit", () => {
    const { container } = renderRow();
    const frame = container.querySelector("div");
    expect(frame?.className).toContain("overflow-x-auto");
    expect(container.querySelector("table")?.style.minWidth).toBe("600px");
  });

  it("marks header cells as column headers", () => {
    renderRow();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });
});

describe("TableMessageRow", () => {
  it("spans the full width so the message is not stuck in column one", () => {
    render(
      <table>
        <tbody>
          <TableMessageRow colSpan={5}>暂无审计记录</TableMessageRow>
        </tbody>
      </table>,
    );
    expect(screen.getByRole("cell").getAttribute("colspan")).toBe("5");
  });
});
