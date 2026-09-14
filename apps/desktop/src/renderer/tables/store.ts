import { isWebPreview } from "@/lib/preview";
import { uiGet, uiSet } from "@/lib/uiStorage";
import type { TableMutation } from "@/services/tables";
import { create } from "zustand";
import {
  defaultDateField,
  defaultGroupField,
  defaultTitleField,
} from "./fieldMeta";
import { newId, nowIso } from "./ids";
import { blankTable, createDemoTable } from "./seed";
import type {
  CellValue,
  ColumnDef,
  DisplayMode,
  FieldType,
  TableDoc,
  TableView,
  ViewConfig,
} from "./types";
import { ROW_LIMIT } from "./types";

const STORAGE_LEAF = "tables.v1";

let persistWrites = true;

export function pauseTablesPersist(): () => void {
  persistWrites = false;
  return () => {
    persistWrites = true;
  };
}

export type TableMutationEvent = TableMutation & { tableId: string };

type TablesRemoteHandler = (event: TableMutationEvent, table: TableDoc) => void;

let remoteHandler: TablesRemoteHandler | null = null;

export function setTablesRemoteHandler(
  handler: TablesRemoteHandler | null,
): void {
  remoteHandler = handler;
}

function defaultOptions(type: FieldType): ColumnDef["options"] {
  if (type !== "singleSelect" && type !== "multiSelect") return undefined;
  return [
    { id: newId(), label: "选项 A", tone: "gray" },
    { id: newId(), label: "选项 B", tone: "blue" },
    { id: newId(), label: "选项 C", tone: "green" },
  ];
}

function touch(table: TableDoc): TableDoc {
  return { ...table, updatedAt: nowIso() };
}

function nextPosition(rows: TableDoc["rows"]): number {
  return rows.reduce((m, r) => Math.max(m, r.position), 0) + 1000;
}

function loadTables(): TableDoc[] {
  const parsed = uiGet<{ tables?: TableDoc[] }>(STORAGE_LEAF);
  if (!parsed || !Array.isArray(parsed.tables)) return [createDemoTable()];
  return parsed.tables;
}

function saveTables(tables: TableDoc[]): void {
  if (!persistWrites) return;
  uiSet(STORAGE_LEAF, { tables });
}

function patchTable(
  tables: TableDoc[],
  id: string,
  fn: (table: TableDoc) => TableDoc,
): TableDoc[] {
  return tables.map((t) => (t.id === id ? touch(fn(t)) : t));
}

function emitRemote(event: TableMutationEvent, tables: TableDoc[]): void {
  if (!remoteHandler || isWebPreview()) return;
  const table = tables.find((t) => t.id === event.tableId);
  if (!table) return;
  remoteHandler(event, table);
}

interface TablesState {
  tables: TableDoc[];
  createTable: () => string;
  deleteTable: (id: string) => void;
  renameTable: (id: string, title: string) => void;
  addColumn: (tableId: string, label: string, type: FieldType) => string;
  updateColumn: (
    tableId: string,
    columnId: string,
    patch: Partial<ColumnDef>,
  ) => void;
  removeColumn: (tableId: string, columnId: string) => void;
  addRow: (
    tableId: string,
  ) => { ok: true; id: string } | { ok: false; reason: "limit" };
  updateCell: (
    tableId: string,
    rowId: string,
    columnId: string,
    value: CellValue,
  ) => void;
  deleteRows: (tableId: string, rowIds: string[]) => void;
  setDisplayMode: (tableId: string, mode: DisplayMode) => void;
  patchView: (
    tableId: string,
    viewId: string,
    patch: Partial<ViewConfig>,
  ) => void;
  switchView: (tableId: string, viewId: string) => void;
  addView: (tableId: string, name: string, displayMode?: DisplayMode) => void;
  renameView: (tableId: string, viewId: string, name: string) => void;
  deleteView: (tableId: string, viewId: string) => void;
  replaceAll: (tables: TableDoc[]) => void;
  replaceTable: (table: TableDoc) => void;
}

export const useTablesStore = create<TablesState>((set, get) => ({
  tables: loadTables(),

  replaceAll: (tables) => {
    saveTables(tables);
    set({ tables });
  },

  replaceTable: (table) => {
    const current = get().tables;
    const tables = current.some((t) => t.id === table.id)
      ? current.map((t) => (t.id === table.id ? table : t))
      : [table, ...current];
    saveTables(tables);
    set({ tables });
  },

  createTable: () => {
    const table = blankTable();
    const tables = [table, ...get().tables];
    saveTables(tables);
    set({ tables });
    return table.id;
  },

  deleteTable: (id) => {
    const tables = get().tables.filter((t) => t.id !== id);
    saveTables(tables);
    set({ tables });
  },

  renameTable: (id, title) => {
    const tables = patchTable(get().tables, id, (t) => ({ ...t, title }));
    saveTables(tables);
    set({ tables });
  },

  addColumn: (tableId, label, type) => {
    const column: ColumnDef = {
      id: newId(),
      label: label.trim() || "未命名",
      type,
      options: defaultOptions(type),
    };
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      columns: [...t.columns, column],
    }));
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "add_column", tableId, column }, tables);
    return column.id;
  },

  updateColumn: (tableId, columnId, patch) => {
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      columns: t.columns.map((c) =>
        c.id === columnId ? { ...c, ...patch } : c,
      ),
    }));
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "update_column", tableId, columnId, patch }, tables);
  },

  removeColumn: (tableId, columnId) => {
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      columns: t.columns.filter((c) => c.id !== columnId),
      rows: t.rows.map((r) => {
        const { [columnId]: _drop, ...cells } = r.cells;
        return { ...r, cells };
      }),
      views: t.views.map((v) => ({
        ...v,
        config: {
          ...v.config,
          groupBy: v.config.groupBy === columnId ? null : v.config.groupBy,
          sort: v.config.sort?.columnId === columnId ? null : v.config.sort,
          hiddenColumnIds: v.config.hiddenColumnIds.filter(
            (id) => id !== columnId,
          ),
          filters: v.config.filters.filter((f) => f.columnId !== columnId),
          modeConfig: {
            ...v.config.modeConfig,
            groupField:
              v.config.modeConfig.groupField === columnId
                ? undefined
                : v.config.modeConfig.groupField,
            dateField:
              v.config.modeConfig.dateField === columnId
                ? undefined
                : v.config.modeConfig.dateField,
            titleField:
              v.config.modeConfig.titleField === columnId
                ? undefined
                : v.config.modeConfig.titleField,
          },
        },
      })),
    }));
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "remove_column", tableId, columnId }, tables);
  },

  addRow: (tableId) => {
    const table = get().tables.find((t) => t.id === tableId);
    if (!table) return { ok: false, reason: "limit" };
    if (table.rows.length >= ROW_LIMIT) return { ok: false, reason: "limit" };
    const id = newId();
    const row = { id, position: nextPosition(table.rows), cells: {} };
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      rows: [...t.rows, row],
    }));
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "upsert_row", tableId, row }, tables);
    return { ok: true, id };
  },

  updateCell: (tableId, rowId, columnId, value) => {
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      rows: t.rows.map((r) =>
        r.id === rowId ? { ...r, cells: { ...r.cells, [columnId]: value } } : r,
      ),
    }));
    saveTables(tables);
    set({ tables });
    emitRemote(
      { type: "update_cells", tableId, rowId, cells: { [columnId]: value } },
      tables,
    );
  },

  deleteRows: (tableId, rowIds) => {
    const drop = new Set(rowIds);
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      rows: t.rows.filter((r) => !drop.has(r.id)),
    }));
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "delete_rows", tableId, rowIds }, tables);
  },

  setDisplayMode: (tableId, mode) => {
    const tables = patchTable(get().tables, tableId, (t) => {
      const modeConfig = { ...activeView(t).config.modeConfig };
      if (mode === "kanban")
        modeConfig.groupField = defaultGroupField(t.columns);
      if (mode === "calendar")
        modeConfig.dateField = defaultDateField(t.columns);
      if (mode === "gallery")
        modeConfig.titleField = defaultTitleField(t.columns);
      return mapActiveView(t, (v) => ({
        ...v,
        displayMode: mode,
        config: { ...v.config, modeConfig },
      }));
    });
    saveTables(tables);
    set({ tables });
    const next = tables.find((t) => t.id === tableId);
    if (next) {
      emitRemote({ type: "set_view", tableId, view: activeView(next) }, tables);
    }
  },

  patchView: (tableId, viewId, patch) => {
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      views: t.views.map((v) =>
        v.id === viewId ? { ...v, config: { ...v.config, ...patch } } : v,
      ),
    }));
    saveTables(tables);
    set({ tables });
    const next = tables.find((t) => t.id === tableId);
    const view = next?.views.find((v) => v.id === viewId);
    if (view) emitRemote({ type: "set_view", tableId, view }, tables);
  },

  switchView: (tableId, viewId) => {
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      activeViewId: viewId,
    }));
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "switch_view", tableId, viewId }, tables);
  },

  addView: (tableId, name, displayMode) => {
    const tables = patchTable(get().tables, tableId, (t) => {
      const current = activeView(t);
      const view: TableView = {
        id: newId(),
        name: name.trim() || "未命名视图",
        displayMode: displayMode ?? current.displayMode,
        config: {
          ...current.config,
          filters: [...current.config.filters],
          hiddenColumnIds: [...current.config.hiddenColumnIds],
          modeConfig: { ...current.config.modeConfig },
        },
      };
      return { ...t, views: [...t.views, view], activeViewId: view.id };
    });
    saveTables(tables);
    set({ tables });
    const next = tables.find((t) => t.id === tableId);
    const view = next ? activeView(next) : null;
    if (view) emitRemote({ type: "save_view", tableId, view }, tables);
  },

  renameView: (tableId, viewId, name) => {
    const tables = patchTable(get().tables, tableId, (t) => ({
      ...t,
      views: t.views.map((v) => (v.id === viewId ? { ...v, name } : v)),
    }));
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "rename_view", tableId, viewId, name }, tables);
  },

  deleteView: (tableId, viewId) => {
    const current = get().tables.find((t) => t.id === tableId);
    if (!current || current.views.length <= 1) return;
    const tables = patchTable(get().tables, tableId, (t) => {
      const views = t.views.filter((v) => v.id !== viewId);
      if (views.length === t.views.length) return t;
      return {
        ...t,
        views,
        activeViewId: t.activeViewId === viewId ? views[0].id : t.activeViewId,
      };
    });
    saveTables(tables);
    set({ tables });
    emitRemote({ type: "delete_view", tableId, viewId }, tables);
  },
}));

function activeView(table: TableDoc): TableView {
  return table.views.find((v) => v.id === table.activeViewId) ?? table.views[0];
}

function mapActiveView(
  table: TableDoc,
  fn: (view: TableView) => TableView,
): TableDoc {
  return {
    ...table,
    views: table.views.map((v) => (v.id === table.activeViewId ? fn(v) : v)),
  };
}

export function resetTablesStore(tables: TableDoc[] = []): void {
  remoteHandler = null;
  saveTables(tables);
  useTablesStore.setState({ tables });
}

export function activeViewOf(table: TableDoc): TableView {
  return activeView(table);
}
