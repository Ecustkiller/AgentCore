import { sendTableTurn } from "@/services/tableTurn";
import * as tablesApi from "@/services/tables";
import { createDemoTable } from "@/tables/seed";
import { resetTablesStore, useTablesStore } from "@/tables/store";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

vi.mock("@/services/tableTurn", () => ({
  sendTableTurn: vi.fn(() => Promise.resolve()),
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
const sendTurn = vi.mocked(sendTableTurn);

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
    sendTurn.mockReset();
    sendTurn.mockResolvedValue(undefined);
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

  it("hydrates REST in production, shows 已感知, and snapshots selection at send", async () => {
    const demo = createDemoTable();
    getTable.mockResolvedValue(demo);
    await act(async () => {
      renderEditor(demo.id);
    });
    expect(await screen.findByText("看板拖拽改状态")).toBeTruthy();
    expect(getTable).toHaveBeenCalledWith(demo.id);
    expect(screen.queryByText("仅本机")).toBeNull();

    fireEvent.click(screen.getByLabelText("全选"));
    expect(screen.getByText("已感知 5 行")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("给表格 Agent 发消息"), {
      target: { value: "把这些标成完成" },
    });
    sendTurn.mockImplementation(async () => {
      fireEvent.click(screen.getByLabelText("全选"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalled());
    expect(sendTurn).toHaveBeenCalledWith(
      demo.id,
      "把这些标成完成",
      expect.objectContaining({
        tableSelection: ["r1", "r2", "r3", "r4", "r5"],
      }),
    );
    await waitFor(() => expect(getTable.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows 打开对话 after the table has a dedicated conversation", async () => {
    const demo = { ...createDemoTable(), conversationId: "conv-table" };
    getTable.mockResolvedValue(demo);
    sendTurn.mockImplementation(async (_id, _content, opts) => {
      opts?.onConversation?.("conv-table");
    });
    await act(async () => {
      renderEditor(demo.id);
    });
    expect(
      await screen.findByRole("button", { name: "打开对话" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("给表格 Agent 发消息"), {
      target: { value: "继续" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    await waitFor(() => expect(sendTurn).toHaveBeenCalled());
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
