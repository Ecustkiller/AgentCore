import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankTable, createDemoTable } from "../seed";
import { resetTablesStore, useTablesStore } from "../store";
import { ROW_LIMIT } from "../types";

describe("tables store", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resetTablesStore([]);
  });

  afterEach(() => {
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("creates a table with title/status/date columns", () => {
    const id = useTablesStore.getState().createTable();
    const table = useTablesStore.getState().tables.find((t) => t.id === id);
    expect(table?.columns.map((c) => c.type)).toEqual([
      "text",
      "singleSelect",
      "date",
    ]);
    expect(table?.rows).toHaveLength(1);
  });

  it("caps rows at 5000", () => {
    const table = blankTable();
    table.rows = Array.from({ length: ROW_LIMIT }, (_, i) => ({
      id: `r${i}`,
      position: i,
      cells: {},
    }));
    resetTablesStore([table]);
    const result = useTablesStore.getState().addRow(table.id);
    expect(result.ok).toBe(false);
  });

  it("renames and deletes", () => {
    resetTablesStore([createDemoTable()]);
    const id = createDemoTable().id;
    useTablesStore.getState().renameTable(id, "新名字");
    expect(useTablesStore.getState().tables[0].title).toBe("新名字");
    useTablesStore.getState().deleteTable(id);
    expect(useTablesStore.getState().tables).toHaveLength(0);
  });

  it("updates column type and renames a view", () => {
    resetTablesStore([createDemoTable()]);
    const id = createDemoTable().id;
    useTablesStore.getState().updateColumn(id, "c-title", { type: "url" });
    expect(useTablesStore.getState().tables[0].columns[0].type).toBe("url");
    useTablesStore.getState().renameView(id, "v-table", "主表");
    expect(useTablesStore.getState().tables[0].views[0].name).toBe("主表");
  });
});
