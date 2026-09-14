import * as tablesApi from "@/services/tables";
import { createDemoTable } from "@/tables/seed";
import { resetTablesStore } from "@/tables/store";
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
import { TablesPage } from "../TablesPage";

vi.mock("@/lib/preview", () => ({
  isWebPreview: () => false,
}));

vi.mock("@/services/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/tables")>();
  return {
    ...actual,
    listTables: vi.fn(),
    createTable: vi.fn(),
    deleteTable: vi.fn(),
  };
});

const list = vi.mocked(tablesApi.listTables);
const create = vi.mocked(tablesApi.createTable);

function renderPage() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<TablesPage />} />
        <Route path="/tables/:tableId" element={<div>编辑器</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TablesPage", () => {
  afterEach(() => {
    cleanup();
    resetTablesStore([]);
  });

  beforeEach(() => {
    resetTablesStore([]);
    list.mockReset();
    create.mockReset();
    list.mockResolvedValue([]);
    create.mockResolvedValue({ ...createDemoTable(), id: "t-new" });
  });

  it("empty state then create via REST", async () => {
    renderPage();
    expect(await screen.findByText("还没有表格")).toBeTruthy();
    expect(screen.queryByText("仅本机")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "新建表格" })[0]);
    });
    expect(create).toHaveBeenCalledWith();
    expect(screen.getByText("编辑器")).toBeTruthy();
  });

  it("lists a saved table from REST", async () => {
    list.mockResolvedValue([
      {
        id: "demo-table",
        title: "阅读清单",
        conversationId: null,
        schemaVersion: 1,
        rowCount: 5,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-13T00:00:00Z",
      },
    ]);
    renderPage();
    expect(await screen.findByText("阅读清单")).toBeTruthy();
    fireEvent.click(screen.getByText("阅读清单"));
    expect(screen.getByText("编辑器")).toBeTruthy();
  });
});
