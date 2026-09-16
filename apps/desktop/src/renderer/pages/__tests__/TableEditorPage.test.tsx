import * as tablesApi from "@/services/tables";
import { createDemoTable } from "@/tables/seed";
import { resetTablesStore, useTablesStore } from "@/tables/store";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import { TableEditorPage } from "../TableEditorPage";

const { isWebPreviewMock } = vi.hoisted(() => ({
  isWebPreviewMock: vi.fn(() => false),
}));

vi.mock("@/lib/preview", () => ({
  isWebPreview: () => isWebPreviewMock(),
}));

vi.mock("@/services/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/tables")>();
  return {
    ...actual,
    getTable: vi.fn(),
    applyTableOps: vi.fn(),
    renameTable: vi.fn(),
    listTables: vi.fn(),
  };
});

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

const getTable = vi.mocked(tablesApi.getTable);
const applyTableOps = vi.mocked(tablesApi.applyTableOps);

function renderEditor(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/tables/${id}`]}>
      <Routes>
        <Route path="/tables/:tableId" element={<TableEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TableEditorPage", () => {
  beforeEach(() => {
    isWebPreviewMock.mockReset().mockReturnValue(false);
    resetTablesStore([]);
    getTable.mockReset();
    applyTableOps.mockReset();
    applyTableOps.mockResolvedValue({
      ok: true,
      level: "L1",
      summary: "",
      needsConfirmation: false,
      batchId: null,
      conflict: false,
      error: null,
      table: null,
    });
  });

  afterEach(() => {
    resetTablesStore([]);
    cleanup();
  });

  it("hydrates REST in production and has no Agent composer", async () => {
    const demo = createDemoTable();
    getTable.mockResolvedValue(demo);
    await act(async () => {
      renderEditor(demo.id);
    });
    expect(await screen.findByText("看板拖拽改状态")).toBeTruthy();
    expect(getTable).toHaveBeenCalledWith(demo.id);
    expect(screen.queryByText("仅本机")).toBeNull();
    expect(screen.queryByLabelText("给表格 Agent 发消息")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开对话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "问 Agent" })).toBeNull();
  });

  it("shows the seed csv path in the editor chrome", async () => {
    const demo = { ...createDemoTable(), sourcePath: "客户.csv" };
    getTable.mockResolvedValue(demo);
    await act(async () => {
      renderEditor(demo.id);
    });
    expect(await screen.findByTitle("客户.csv")).toBeTruthy();
  });

  it("does not link into the dedicated conversation from the editor", async () => {
    const demo = { ...createDemoTable(), conversationId: "conv-table" };
    getTable.mockResolvedValue(demo);
    await act(async () => {
      renderEditor(demo.id);
    });
    expect(await screen.findByText("看板拖拽改状态")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开对话" })).toBeNull();
    expect(screen.queryByLabelText("给表格 Agent 发消息")).toBeNull();
  });

  it("preview keeps the local store and does not GET /v1/tables", async () => {
    isWebPreviewMock.mockReturnValue(true);
    const demo = createDemoTable();
    resetTablesStore([demo]);
    await act(async () => {
      renderEditor(demo.id);
    });
    expect(await screen.findByText("看板拖拽改状态")).toBeTruthy();
    expect(getTable).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("给表格 Agent 发消息")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新建行" }));
    expect(useTablesStore.getState().tables[0].rows.length).toBe(
      demo.rows.length + 1,
    );
    expect(applyTableOps).not.toHaveBeenCalled();
  });
});
