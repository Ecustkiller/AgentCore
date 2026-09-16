import { ApiError, BASE_URL } from "@/services/api";
import {
  type ApiTableDetail,
  applyTableOps,
  fromApiTable,
  fromApiViewConfig,
  isTableConflict,
  lookupTableBySource,
  opsForMutation,
} from "@/services/tables";
import { createDemoTable } from "@/tables/seed";
import { emptyViewConfig } from "@/tables/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiTable: ApiTableDetail = {
  id: "tbl-1",
  title: "阅读清单",
  conversation_id: "conv-1",
  schema_version: 4,
  active_view_id: "v-table",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-13T00:00:00Z",
  columns: [
    { id: "c-title", label: "标题", type: "text" },
    {
      id: "c-status",
      label: "状态",
      type: "singleSelect",
      options: [{ id: "s-todo", label: "待办", tone: "gray" }],
    },
  ],
  rows: [
    {
      id: "r1",
      position: 1000,
      cells: { "c-title": "飞书", "c-status": "s-todo" },
    },
  ],
  views: [
    {
      id: "v-table",
      name: "表格",
      display_mode: "table",
      is_default: true,
      config: {
        filters: [
          {
            id: "f1",
            column_id: "c-status",
            op: "eq",
            value: "s-todo",
          },
        ],
        sort: { column_id: "c-title", dir: "asc" },
        group_by: "c-status",
        hidden_column_ids: ["c-title"],
        density: "compact",
        mode_config: { group_field: "c-status", title_field: "c-title" },
      },
    },
  ],
};

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("tables mapper", () => {
  it("maps snake_case API detail onto camelCase TableDoc", () => {
    const doc = fromApiTable(apiTable);
    expect(doc.id).toBe("tbl-1");
    expect(doc.conversationId).toBe("conv-1");
    expect(doc.schemaVersion).toBe(4);
    expect(doc.sourcePath).toBeNull();
    expect(doc.activeViewId).toBe("v-table");
    expect(doc.columns[1]?.options?.[0]?.id).toBe("s-todo");
    const view = doc.views[0];
    expect(view.displayMode).toBe("table");
    expect(view.isDefault).toBe(true);
    expect(view.config.filters[0]).toEqual({
      id: "f1",
      columnId: "c-status",
      op: "eq",
      value: "s-todo",
    });
    expect(view.config.sort).toEqual({ columnId: "c-title", dir: "asc" });
    expect(view.config.groupBy).toBe("c-status");
    expect(view.config.hiddenColumnIds).toEqual(["c-title"]);
    expect(view.config.modeConfig).toEqual({
      groupField: "c-status",
      titleField: "c-title",
    });
  });

  it("round-trips view config through opsForMutation set_view", () => {
    const view = fromApiTable(apiTable).views[0];
    const ops = opsForMutation({ type: "set_view", view });
    expect(ops?.[0]).toMatchObject({
      op: "set_view",
      display_mode: "table",
      group_by: "c-status",
      hidden_column_ids: ["c-title"],
      mode_config: { group_field: "c-status", title_field: "c-title" },
      sort: { column_id: "c-title", dir: "asc" },
    });
  });
});

describe("opsForMutation", () => {
  it("maps kanban / cell edits to update_cells", () => {
    expect(
      opsForMutation({
        type: "update_cells",
        rowId: "r2",
        cells: { "c-status": "s-doing" },
      }),
    ).toEqual([
      {
        op: "update_cells",
        row_id: "r2",
        cells: { "c-status": "s-doing" },
      },
    ]);
  });

  it("maps delete_view", () => {
    expect(opsForMutation({ type: "delete_view", viewId: "v-x" })).toEqual([
      { op: "delete_view", view_id: "v-x" },
    ]);
  });

  it("maps update_column type", () => {
    expect(
      opsForMutation({
        type: "update_column",
        columnId: "c-title",
        patch: { type: "url" },
      }),
    ).toEqual([{ op: "update_column", column_id: "c-title", type: "url" }]);
  });

  it("does not invent a view id on save_view so the server can mint one", () => {
    const demo = createDemoTable();
    const ops = opsForMutation({ type: "save_view", view: demo.views[1] });
    expect(ops?.[0]).toMatchObject({
      op: "save_view",
      name: "看板",
      display_mode: "kanban",
    });
    expect(ops?.[0]).not.toHaveProperty("view_id");
    expect(ops?.[0]).not.toHaveProperty("id");
  });
});

describe("fromApiViewConfig", () => {
  it("falls back to empty config", () => {
    expect(fromApiViewConfig(null)).toEqual(emptyViewConfig());
  });

  it("reads column_widths", () => {
    expect(
      fromApiViewConfig({ column_widths: { "c-title": 240 } }).columnWidths,
    ).toEqual({ "c-title": 240 });
  });
});

describe("applyTableOps", () => {
  it("POSTs confirm=true and snake_case ops", async () => {
    fetchMock.mockResolvedValue(
      okJson({
        ok: true,
        level: "L2",
        summary: "加列",
        table: apiTable,
      }),
    );
    const result = await applyTableOps(
      "tbl-1",
      [{ op: "add_column", id: "c-new", label: "备注", type: "text" }],
      { schemaBaseline: 4 },
    );
    expect(result.table?.schemaVersion).toBe(4);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/v1/tables/tbl-1/ops`);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    ) as {
      confirm: boolean;
      schema_baseline: number;
      ops: unknown[];
    };
    expect(body.confirm).toBe(true);
    expect(body.schema_baseline).toBe(4);
    expect(body.ops[0]).toMatchObject({ op: "add_column" });
  });

  it("surfaces 409 as ApiError so callers reload", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "CONFLICT", message: "结构已更新" } }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    await expect(
      applyTableOps("tbl-1", [{ op: "add_column", label: "x", type: "text" }]),
    ).rejects.toSatisfy(
      (err) => isTableConflict(err) && err instanceof ApiError,
    );
  });

  it("looks up a seeded csv and treats 404 as miss", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        id: "tbl-1",
        title: "客户",
        schema_version: 1,
        row_count: 1,
        source_path: "客户.csv",
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-13T00:00:00Z",
      }),
    );
    const hit = await lookupTableBySource({
      path: "客户.csv",
      folderId: "f1",
    });
    expect(hit?.id).toBe("tbl-1");
    expect(hit?.sourcePath).toBe("客户.csv");
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/v1/tables/by-source?",
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "path=%E5%AE%A2%E6%88%B7.csv",
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain("folder_id=f1");

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "表格不存在" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(
      lookupTableBySource({ path: "no.csv", conversationId: "c1" }),
    ).resolves.toBeNull();
  });
});
