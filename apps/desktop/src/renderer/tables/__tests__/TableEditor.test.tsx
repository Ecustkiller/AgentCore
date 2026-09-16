import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @vitest-environment jsdom
import { TableEditor } from "../TableEditor";
import { createDemoTable } from "../seed";
import { resetTablesStore, useTablesStore } from "../store";

function Harness() {
  const table = useTablesStore((s) => s.tables[0]);
  if (!table) return null;
  return <TableEditor table={table} />;
}

describe("TableEditor", () => {
  beforeEach(() => {
    resetTablesStore([createDemoTable()]);
  });
  afterEach(cleanup);

  it("renders demo rows and switches to kanban", () => {
    render(<Harness />);
    expect(screen.getByText("看板拖拽改状态")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "看板" }));
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("待办")).toBeTruthy();
  });

  it("adds a row", () => {
    render(<Harness />);
    const before = useTablesStore.getState().tables[0].rows.length;
    fireEvent.click(screen.getByRole("button", { name: "新建行" }));
    expect(useTablesStore.getState().tables[0].rows.length).toBe(before + 1);
  });

  it("selects a cell on click and moves with arrows", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("飞书多维表格怎么做筛选"));
    expect(
      screen.getByRole("gridcell", { selected: true }).textContent,
    ).toContain("飞书多维表格怎么做筛选");
    fireEvent.keyDown(screen.getByRole("grid", { name: "表格" }), {
      key: "ArrowRight",
    });
    expect(
      screen.getByRole("gridcell", { selected: true }).textContent,
    ).toContain("完成");
  });

  it("renames a view from the tab", () => {
    render(<Harness />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "视图 表格" }));
    const input = screen.getByLabelText("视图名称");
    fireEvent.change(input, { target: { value: "主表" } });
    fireEvent.blur(input);
    expect(useTablesStore.getState().tables[0].views[0].name).toBe("主表");
  });

  it("renames a column from the header menu", async () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "列 标题" }), {
      button: 0,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "字段设置" }));
    const name = await screen.findByLabelText("列名称");
    fireEvent.change(name, { target: { value: "事项" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(useTablesStore.getState().tables[0].columns[0].label).toBe("事项");
  });

  it("selects a kanban card for batch actions", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "看板" }));
    fireEvent.click(screen.getByText("看板拖拽改状态"));
    expect(screen.getByRole("button", { name: "删除 1 行" })).toBeTruthy();
  });

  it("selects a gallery card", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "画廊" }));
    fireEvent.click(screen.getByText("画廊卡片扫一眼"));
    expect(screen.getByRole("button", { name: "删除 1 行" })).toBeTruthy();
  });

  it("selects a calendar event", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "日历" }));
    fireEvent.click(
      screen.getByRole("button", { name: "飞书多维表格怎么做筛选" }),
    );
    expect(screen.getByRole("button", { name: "删除 1 行" })).toBeTruthy();
  });

  it("fills selected rows from the toolbar", async () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByLabelText("选择行")[0]);
    fireEvent.click(screen.getByRole("button", { name: "改 1 行" }));
    const fill = await screen.findByLabelText("批量填写");
    fireEvent.change(fill, { target: { value: "批量标题" } });
    fireEvent.click(screen.getByRole("button", { name: "应用到 1 行" }));
    expect(useTablesStore.getState().tables[0].rows[0].cells["c-title"]).toBe(
      "批量标题",
    );
  });

  it("deletes a view from its menu", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "视图 日历" }));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "视图 日历 操作" }),
      {
        button: 0,
      },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除视图" }));
    expect(
      useTablesStore.getState().tables[0].views.map((v) => v.id),
    ).not.toContain("v-cal");
  });

  it("lets the user pick an existing column when kanban config is stale", () => {
    const table = createDemoTable();
    table.views[0] = {
      ...table.views[0],
      displayMode: "kanban",
      config: {
        ...table.views[0].config,
        modeConfig: { groupField: "missing" },
      },
    };
    resetTablesStore([table]);
    render(<Harness />);
    expect(screen.getByLabelText("分组列")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "使用此列" }));
    expect(
      useTablesStore.getState().tables[0].views[0].config.modeConfig.groupField,
    ).toBe("c-status");
    expect(screen.getByText("进行中")).toBeTruthy();
  });

  it("shows repair when the kanban group column is hidden", () => {
    const table = createDemoTable();
    table.views[0] = {
      ...table.views[0],
      displayMode: "kanban",
      config: {
        ...table.views[0].config,
        modeConfig: { groupField: "c-status" },
        hiddenColumnIds: ["c-status"],
      },
    };
    resetTablesStore([table]);
    render(<Harness />);
    expect(screen.getByLabelText("分组列")).toBeTruthy();
    expect(screen.queryByText("进行中")).toBeNull();
  });

  it("keeps search collapsed until 查找", () => {
    render(<Harness />);
    expect(screen.queryByLabelText("查找表格")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查找" }));
    expect(screen.getByLabelText("查找表格")).toBeTruthy();
  });

  it("shows filter chips and removes them", () => {
    const table = createDemoTable();
    table.views[0] = {
      ...table.views[0],
      config: {
        ...table.views[0].config,
        filters: [
          { id: "f1", columnId: "c-status", op: "eq", value: "s-done" },
        ],
      },
    };
    resetTablesStore([table]);
    render(<Harness />);
    expect(screen.getByText("状态 是 完成")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除 状态 是 完成" }));
    expect(useTablesStore.getState().tables[0].views[0].config.filters).toEqual(
      [],
    );
  });

  it("exports csv from the overflow menu", async () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "更多" }), {
      button: 0,
    });
    expect(
      await screen.findByRole("menuitem", { name: "导出 CSV" }),
    ).toBeTruthy();
  });

  it("adds a column from the grid edge", () => {
    render(<Harness />);
    const before = useTablesStore.getState().tables[0].columns.length;
    fireEvent.click(screen.getByRole("button", { name: "添加列" }));
    expect(useTablesStore.getState().tables[0].columns.length).toBe(before + 1);
  });

  it("resizes a column from the header handle", () => {
    render(<Harness />);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "调整标题列宽" }),
      {
        clientX: 100,
      },
    );
    fireEvent.pointerUp(window, { clientX: 180 });
    expect(
      useTablesStore.getState().tables[0].views[0].config.columnWidths[
        "c-title"
      ],
    ).toBe(240);
  });
});
