import {
  compareCell,
  defaultDateField,
  defaultGroupField,
  defaultTitleField,
  isEmptyValue,
  matchesFilter,
  optionLabel,
} from "./fieldMeta";
import type {
  ColumnDef,
  DisplayMode,
  TableRow,
  TableView,
  ViewConfig,
} from "./types";

export interface RowGroup {
  key: string;
  label: string;
  rows: TableRow[];
}

export function visibleColumns(
  columns: ColumnDef[],
  hiddenColumnIds: string[],
): ColumnDef[] {
  const hidden = new Set(hiddenColumnIds);
  return columns.filter((c) => !hidden.has(c.id));
}

export function filterRows(
  rows: TableRow[],
  columns: ColumnDef[],
  config: ViewConfig,
): TableRow[] {
  if (config.filters.length === 0) return rows;
  const byId = new Map(columns.map((c) => [c.id, c]));
  return rows.filter((row) =>
    config.filters.every((clause) => {
      const col = byId.get(clause.columnId);
      if (!col) return true;
      return matchesFilter(
        col,
        row.cells[col.id] ?? null,
        clause.op,
        clause.value,
      );
    }),
  );
}

export function sortRows(
  rows: TableRow[],
  columns: ColumnDef[],
  config: ViewConfig,
): TableRow[] {
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const sort = config.sort;
  if (!sort) return ordered;
  const col = columns.find((c) => c.id === sort.columnId);
  if (!col) return ordered;
  const dir = sort.dir === "desc" ? -1 : 1;
  return ordered.sort((a, b) => {
    const av = a.cells[col.id] ?? null;
    const bv = b.cells[col.id] ?? null;
    const aEmpty = isEmptyValue(av);
    const bEmpty = isEmptyValue(bv);
    if (aEmpty && bEmpty) return a.position - b.position;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const cmp = compareCell(col.type, av, bv);
    return cmp === 0 ? a.position - b.position : cmp * dir;
  });
}

export function queryRows(
  rows: TableRow[],
  columns: ColumnDef[],
  config: ViewConfig,
): TableRow[] {
  return sortRows(filterRows(rows, columns, config), columns, config);
}

export function groupRows(
  rows: TableRow[],
  columns: ColumnDef[],
  groupBy: string | null,
): RowGroup[] | null {
  if (!groupBy) return null;
  const col = columns.find((c) => c.id === groupBy);
  if (!col) return null;
  const buckets = new Map<string, RowGroup>();
  const ensure = (key: string, label: string) => {
    let g = buckets.get(key);
    if (!g) {
      g = { key, label, rows: [] };
      buckets.set(key, g);
    }
    return g;
  };
  if (col.type === "singleSelect") {
    for (const opt of col.options ?? []) {
      ensure(opt.id, opt.label);
    }
  }
  const unfiled = ensure("", "未填写");
  for (const row of rows) {
    const raw = row.cells[col.id];
    if (col.type === "multiSelect" && Array.isArray(raw) && raw.length > 0) {
      for (const id of raw) {
        ensure(id, optionLabel(col, id)).rows.push(row);
      }
      continue;
    }
    if (col.type === "checkbox") {
      const on = Boolean(raw);
      ensure(on ? "1" : "0", on ? "已勾选" : "未勾选").rows.push(row);
      continue;
    }
    if (isEmptyValue(raw ?? null)) {
      unfiled.rows.push(row);
      continue;
    }
    const key = String(raw);
    ensure(
      key,
      col.type === "singleSelect" ? optionLabel(col, key) : key,
    ).rows.push(row);
  }
  if (unfiled.rows.length === 0) buckets.delete("");
  return [...buckets.values()];
}

export function searchRows(
  rows: TableRow[],
  columns: ColumnDef[],
  q: string,
): TableRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    columns.some((col) =>
      String(row.cells[col.id] ?? "")
        .toLowerCase()
        .includes(needle),
    ),
  );
}

function liveField(
  columns: ColumnDef[],
  id: string | undefined,
  ok: (column: ColumnDef) => boolean,
): string | undefined {
  if (!id) return undefined;
  const col = columns.find((c) => c.id === id);
  return col && ok(col) ? id : undefined;
}

export function candidateColumnsForMode(
  mode: DisplayMode,
  columns: ColumnDef[],
): ColumnDef[] {
  if (mode === "kanban")
    return columns.filter((c) => c.type === "singleSelect");
  if (mode === "calendar") {
    return columns.filter((c) => c.type === "date" || c.type === "datetime");
  }
  if (mode === "gallery") return columns.filter((c) => c.type === "text");
  return [];
}

export function resolveModeConfig(
  view: TableView,
  columns: ColumnDef[],
): { ok: boolean; reason?: string } & TableView["config"]["modeConfig"] {
  const mode = view.displayMode;
  const cfg = { ...view.config.modeConfig };
  if (mode === "kanban") {
    cfg.groupField = liveField(
      columns,
      cfg.groupField,
      (c) => c.type === "singleSelect",
    );
    if (!cfg.groupField) return { ok: false, reason: "kanban", ...cfg };
  }
  if (mode === "calendar") {
    cfg.dateField = liveField(
      columns,
      cfg.dateField,
      (c) => c.type === "date" || c.type === "datetime",
    );
    if (!cfg.dateField) return { ok: false, reason: "calendar", ...cfg };
  }
  if (mode === "gallery") {
    cfg.titleField = liveField(
      columns,
      cfg.titleField,
      (c) => c.type === "text",
    );
    if (!cfg.titleField) return { ok: false, reason: "gallery", ...cfg };
  }
  return { ok: true, ...cfg };
}

export function canUseMode(mode: DisplayMode, columns: ColumnDef[]): boolean {
  if (mode === "table") return true;
  if (mode === "kanban") return Boolean(defaultGroupField(columns));
  if (mode === "calendar") return Boolean(defaultDateField(columns));
  return Boolean(defaultTitleField(columns));
}
