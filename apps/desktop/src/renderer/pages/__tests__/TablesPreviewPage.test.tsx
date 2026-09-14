import * as tablesApi from "@/services/tables";
import { resetTablesStore } from "@/tables/store";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import { TablesPreviewPage } from "../TablesPreviewPage";

vi.mock("@/services/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/tables")>();
  return {
    ...actual,
    listTables: vi.fn(),
    getTable: vi.fn(),
    createTable: vi.fn(),
    applyTableOps: vi.fn(),
    deleteTable: vi.fn(),
    renameTable: vi.fn(),
  };
});

const listTables = vi.mocked(tablesApi.listTables);
const getTable = vi.mocked(tablesApi.getTable);
const applyTableOps = vi.mocked(tablesApi.applyTableOps);

describe("TablesPreviewPage", () => {
  beforeEach(() => {
    window.__WEB_PREVIEW__ = true;
    resetTablesStore([]);
    listTables.mockReset();
    getTable.mockReset();
    applyTableOps.mockReset();
  });

  afterEach(() => {
    window.__WEB_PREVIEW__ = undefined;
    resetTablesStore([]);
    cleanup();
  });

  it("seeds the demo table locally and never calls /v1/tables", async () => {
    await act(async () => {
      render(<TablesPreviewPage />);
    });
    expect(await screen.findByText("看板拖拽改状态")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "新建行" }));
    });
    expect(listTables).not.toHaveBeenCalled();
    expect(getTable).not.toHaveBeenCalled();
    expect(applyTableOps).not.toHaveBeenCalled();
  });
});
