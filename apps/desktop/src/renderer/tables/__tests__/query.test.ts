import { describe, expect, it } from "vitest";
import {
  availableDisplayModes,
  matchesFilter,
  parsePasted,
} from "../fieldMeta";
import { filterRows, groupRows, queryRows, resolveModeConfig } from "../query";
import { createDemoTable } from "../seed";
import { emptyViewConfig } from "../types";

function demoColumn(table: ReturnType<typeof createDemoTable>, id: string) {
  const column = table.columns.find((c) => c.id === id);
  if (!column) throw new Error(`demo table missing ${id}`);
  return column;
}

describe("tables query", () => {
  const table = createDemoTable();
  const status = demoColumn(table, "c-status");

  it("filters by singleSelect eq", () => {
    const rows = filterRows(table.rows, table.columns, {
      ...emptyViewConfig(),
      filters: [{ id: "f1", columnId: "c-status", op: "eq", value: "s-done" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].cells["c-title"]).toBe("飞书多维表格怎么做筛选");
  });

  it("groups by status including empty buckets", () => {
    const groups = groupRows(table.rows, table.columns, "c-status");
    expect(groups?.map((g) => g.key)).toEqual(["s-todo", "s-doing", "s-done"]);
    expect(groups?.find((g) => g.key === "s-todo")?.rows.length).toBe(2);
  });

  it("sorts numbers", () => {
    const rows = queryRows(table.rows, table.columns, {
      ...emptyViewConfig(),
      sort: { columnId: "c-score", dir: "desc" },
    });
    expect(rows[0].cells["c-score"]).toBe(5);
  });

  it("matches contains case-insensitively", () => {
    expect(
      matchesFilter(table.columns[0], "看板拖拽改状态", "contains", "看板"),
    ).toBe(true);
  });

  it("enables kanban/calendar/gallery from demo schema", () => {
    expect(availableDisplayModes(table.columns)).toEqual([
      "table",
      "kanban",
      "calendar",
      "gallery",
    ]);
  });

  it("does not match empty checkbox as eq true", () => {
    expect(matchesFilter(status, null, "eq", "s-todo")).toBe(false);
  });

  it("parses pasted option labels", () => {
    expect(parsePasted(status, "完成")).toBe("s-done");
    expect(parsePasted(table.columns[0], "  hello ")).toBe("hello");
    expect(parsePasted(demoColumn(table, "c-score"), "3.5")).toBe(3.5);
  });

  it("treats a missing kanban group field as a repair state", () => {
    const view = {
      ...table.views[1],
      config: {
        ...table.views[1].config,
        modeConfig: { groupField: "gone" },
      },
    };
    const resolved = resolveModeConfig(view, table.columns);
    expect(resolved.ok).toBe(false);
    expect(resolved.groupField).toBeUndefined();
  });

  it("treats a hidden kanban group field as a repair state", () => {
    const view = table.views[1];
    const groupId = view.config.modeConfig.groupField;
    const visible = table.columns.filter((c) => c.id !== groupId);
    const resolved = resolveModeConfig(view, visible);
    expect(resolved.ok).toBe(false);
  });
});
