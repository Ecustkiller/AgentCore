import { ApiError } from "@/services/api";
import { applyTableOps, getTable } from "@/services/tables";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTablesRemote } from "../remote";
import { createDemoTable } from "../seed";
import { resetTablesStore, useTablesStore } from "../store";

vi.mock("@/lib/preview", () => ({
  isWebPreview: () => false,
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

vi.mock("@/services/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/tables")>();
  return {
    ...actual,
    applyTableOps: vi.fn(),
    getTable: vi.fn(),
  };
});

const applyOps = vi.mocked(applyTableOps);
const load = vi.mocked(getTable);

describe("installTablesRemote", () => {
  beforeEach(() => {
    resetTablesStore([createDemoTable()]);
    applyOps.mockReset();
    load.mockReset();
  });

  afterEach(() => {
    resetTablesStore([]);
  });

  it("POSTs update_cells with confirm via applyTableOps", async () => {
    applyOps.mockResolvedValue({
      ok: true,
      level: "L1",
      summary: "改格子",
      needsConfirmation: false,
      batchId: "b",
      conflict: false,
      error: null,
      table: null,
    });
    const stop = installTablesRemote("demo-table");
    useTablesStore
      .getState()
      .updateCell("demo-table", "r2", "c-status", "s-done");
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalled());
    expect(applyOps).toHaveBeenCalledWith(
      "demo-table",
      [
        {
          op: "update_cells",
          row_id: "r2",
          cells: { "c-status": "s-done" },
        },
      ],
      { schemaBaseline: 1 },
    );
    stop();
  });

  it("reloads the table on 409", async () => {
    const fresh = { ...createDemoTable(), title: "别人改过了" };
    applyOps.mockRejectedValue(
      new ApiError(409, '{"error":{"code":"CONFLICT"}}'),
    );
    load.mockResolvedValue(fresh);
    const stop = installTablesRemote("demo-table");
    useTablesStore.getState().addColumn("demo-table", "备注", "text");
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("demo-table"));
    expect(useTablesStore.getState().tables[0].title).toBe("别人改过了");
    stop();
  });

  it("POSTs delete_view", async () => {
    applyOps.mockResolvedValue({
      ok: true,
      level: "L1",
      summary: "删视图",
      needsConfirmation: false,
      batchId: "b",
      conflict: false,
      error: null,
      table: null,
    });
    const stop = installTablesRemote("demo-table");
    const extra = useTablesStore.getState().tables[0].views[1].id;
    useTablesStore.getState().deleteView("demo-table", extra);
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalled());
    expect(applyOps).toHaveBeenCalledWith(
      "demo-table",
      [{ op: "delete_view", view_id: extra }],
      { schemaBaseline: 1 },
    );
    stop();
  });
});
