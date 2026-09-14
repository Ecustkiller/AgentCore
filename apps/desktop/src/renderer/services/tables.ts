import { ApiError, api } from "@/services/api";
import {
  type CellValue,
  type ColumnDef,
  type DisplayMode,
  FIELD_TYPES,
  type FieldType,
  type FilterClause,
  type ModeConfig,
  type SelectOption,
  type TableDoc,
  type TableRow,
  type TableView,
  type ViewConfig,
  emptyViewConfig,
} from "@/tables/types";

/** Wire shapes — aligned with `apps/server/agentcore/api/schemas/tables.py`. */
export type ApiTableColumn = {
  id: string;
  label: string;
  type: string;
  options?: Array<Record<string, unknown>> | null;
};

export type ApiTableRow = {
  id: string;
  cells: Record<string, unknown>;
  position: number;
};

export type ApiTableView = {
  id: string;
  name: string;
  display_mode: string;
  config: Record<string, unknown>;
  is_default?: boolean;
};

export type ApiTableDetail = {
  id: string;
  title: string;
  conversation_id?: string | null;
  schema_version: number;
  columns: ApiTableColumn[];
  rows: ApiTableRow[];
  views: ApiTableView[];
  active_view_id: string;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ApiTableSummary = {
  id: string;
  title: string;
  conversation_id?: string | null;
  schema_version: number;
  row_count: number;
  created_at: string;
  updated_at: string;
};

export type ApiTableOpsResult = {
  ok: boolean;
  level: string;
  summary: string;
  needs_confirmation?: boolean;
  batch_id?: string | null;
  conflict?: boolean;
  error?: string | null;
  table?: ApiTableDetail | null;
};

export type TableSummary = {
  id: string;
  title: string;
  conversationId: string | null;
  schemaVersion: number;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TableOpsResult = {
  ok: boolean;
  level: string;
  summary: string;
  needsConfirmation: boolean;
  batchId: string | null;
  conflict: boolean;
  error: string | null;
  table: TableDoc | null;
};

export type TableOp = Record<string, unknown>;

export type TableMutation =
  | { type: "add_column"; column: ColumnDef }
  | { type: "update_column"; columnId: string; patch: Partial<ColumnDef> }
  | { type: "remove_column"; columnId: string }
  | { type: "upsert_row"; row: TableRow }
  | { type: "update_cells"; rowId: string; cells: Record<string, CellValue> }
  | { type: "delete_rows"; rowIds: string[] }
  | { type: "set_view"; view: TableView }
  | { type: "save_view"; view: TableView }
  | { type: "switch_view"; viewId: string }
  | { type: "rename_view"; viewId: string; name: string }
  | { type: "delete_view"; viewId: string };

const DISPLAY_MODES: readonly DisplayMode[] = [
  "table",
  "kanban",
  "calendar",
  "gallery",
];

function asFieldType(raw: string): FieldType | null {
  return (FIELD_TYPES as readonly string[]).includes(raw)
    ? (raw as FieldType)
    : null;
}

function asDisplayMode(raw: string): DisplayMode {
  return DISPLAY_MODES.includes(raw as DisplayMode)
    ? (raw as DisplayMode)
    : "table";
}

function iso(raw: string | null | undefined): string {
  return raw || new Date().toISOString();
}

function fromApiOption(raw: Record<string, unknown>): SelectOption | null {
  const id = String(raw.id ?? "").trim();
  const label = String(raw.label ?? "").trim();
  if (!id || !label) return null;
  const tone = raw.tone;
  const option: SelectOption = { id, label };
  if (
    tone === "gray" ||
    tone === "blue" ||
    tone === "green" ||
    tone === "orange" ||
    tone === "red"
  ) {
    option.tone = tone;
  }
  return option;
}

function fromApiColumn(raw: ApiTableColumn): ColumnDef | null {
  const type = asFieldType(raw.type);
  if (!type) return null;
  const col: ColumnDef = {
    id: raw.id,
    label: raw.label,
    type,
  };
  if (raw.options && Array.isArray(raw.options)) {
    col.options = raw.options
      .map((o) =>
        o && typeof o === "object"
          ? fromApiOption(o as Record<string, unknown>)
          : null,
      )
      .filter((o): o is SelectOption => o !== null);
  }
  return col;
}

function fromApiFilter(raw: unknown): FilterClause | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? "").trim();
  const columnId = String(o.column_id ?? o.columnId ?? "").trim();
  const op = o.op;
  if (!id || !columnId || typeof op !== "string") return null;
  return {
    id,
    columnId,
    op: op as FilterClause["op"],
    value: (o.value ?? null) as CellValue,
  };
}

function fromApiModeConfig(raw: unknown): ModeConfig {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const out: ModeConfig = {};
  const group = o.group_field ?? o.groupField;
  const date = o.date_field ?? o.dateField;
  const title = o.title_field ?? o.titleField;
  const subs = o.subtitle_fields ?? o.subtitleFields;
  const cards = o.card_fields ?? o.cardFields;
  if (typeof group === "string") out.groupField = group;
  if (typeof date === "string") out.dateField = date;
  if (typeof title === "string") out.titleField = title;
  if (Array.isArray(subs)) {
    out.subtitleFields = subs.map((x) => String(x));
  }
  if (Array.isArray(cards)) {
    out.cardFields = cards.map((x) => String(x));
  }
  return out;
}

export function fromApiViewConfig(raw: unknown): ViewConfig {
  const base = emptyViewConfig();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  const filters = Array.isArray(o.filters)
    ? o.filters.map(fromApiFilter).filter((f): f is FilterClause => f !== null)
    : base.filters;
  let sort: ViewConfig["sort"] = null;
  if (o.sort && typeof o.sort === "object") {
    const s = o.sort as Record<string, unknown>;
    const columnId = String(s.column_id ?? s.columnId ?? "").trim();
    const dir = s.dir;
    if (columnId && (dir === "asc" || dir === "desc")) {
      sort = { columnId, dir };
    }
  }
  const groupByRaw = o.group_by ?? o.groupBy;
  const hiddenRaw = o.hidden_column_ids ?? o.hiddenColumnIds;
  const density =
    o.density === "compact" ||
    o.density === "comfortable" ||
    o.density === "loose"
      ? o.density
      : base.density;
  return {
    filters,
    sort,
    groupBy: typeof groupByRaw === "string" ? groupByRaw : null,
    hiddenColumnIds: Array.isArray(hiddenRaw)
      ? hiddenRaw.map((x) => String(x))
      : [],
    density,
    modeConfig: fromApiModeConfig(o.mode_config ?? o.modeConfig),
  };
}

function fromApiView(raw: ApiTableView): TableView {
  return {
    id: raw.id,
    name: raw.name,
    displayMode: asDisplayMode(raw.display_mode),
    config: fromApiViewConfig(raw.config),
    isDefault: Boolean(raw.is_default),
  };
}

function fromApiRow(raw: ApiTableRow): TableRow {
  const cells: Record<string, CellValue> = {};
  for (const [key, value] of Object.entries(raw.cells ?? {})) {
    cells[key] = value as CellValue;
  }
  return {
    id: raw.id,
    cells,
    position: Number(raw.position) || 0,
  };
}

export function fromApiTable(raw: ApiTableDetail): TableDoc {
  const columns = raw.columns
    .map(fromApiColumn)
    .filter((c): c is ColumnDef => c !== null);
  const views = (raw.views ?? []).map(fromApiView);
  return {
    id: raw.id,
    title: raw.title,
    conversationId: raw.conversation_id ?? null,
    schemaVersion: raw.schema_version,
    columns,
    rows: (raw.rows ?? []).map(fromApiRow),
    views,
    activeViewId: raw.active_view_id || views[0]?.id || "",
    createdAt: iso(raw.created_at),
    updatedAt: iso(raw.updated_at),
  };
}

export function fromApiSummary(raw: ApiTableSummary): TableSummary {
  return {
    id: raw.id,
    title: raw.title,
    conversationId: raw.conversation_id ?? null,
    schemaVersion: raw.schema_version,
    rowCount: raw.row_count,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toApiModeConfig(config: ModeConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.groupField) out.group_field = config.groupField;
  if (config.dateField) out.date_field = config.dateField;
  if (config.titleField) out.title_field = config.titleField;
  if (config.subtitleFields) out.subtitle_fields = config.subtitleFields;
  if (config.cardFields) out.card_fields = config.cardFields;
  return out;
}

function toApiViewFields(view: TableView): Record<string, unknown> {
  const sort = view.config.sort
    ? { column_id: view.config.sort.columnId, dir: view.config.sort.dir }
    : null;
  return {
    display_mode: view.displayMode,
    filters: view.config.filters.map((f) => ({
      id: f.id,
      column_id: f.columnId,
      op: f.op,
      value: f.value,
    })),
    sort,
    group_by: view.config.groupBy,
    hidden_column_ids: view.config.hiddenColumnIds,
    density: view.config.density,
    mode_config: toApiModeConfig(view.config.modeConfig),
  };
}

/** Closed-set ops in snake_case. */
export function opsForMutation(mutation: TableMutation): TableOp[] | null {
  switch (mutation.type) {
    case "add_column":
      return [
        {
          op: "add_column",
          id: mutation.column.id,
          label: mutation.column.label,
          type: mutation.column.type,
          options: mutation.column.options,
        },
      ];
    case "update_column":
      return [
        {
          op: "update_column",
          column_id: mutation.columnId,
          ...("label" in mutation.patch ? { label: mutation.patch.label } : {}),
          ...("type" in mutation.patch ? { type: mutation.patch.type } : {}),
          ...("options" in mutation.patch
            ? { options: mutation.patch.options }
            : {}),
        },
      ];
    case "remove_column":
      return [{ op: "remove_column", column_id: mutation.columnId }];
    case "upsert_row":
      return [
        {
          op: "upsert_rows",
          rows: [
            {
              id: mutation.row.id,
              cells: mutation.row.cells,
              position: mutation.row.position,
            },
          ],
        },
      ];
    case "update_cells":
      return [
        {
          op: "update_cells",
          row_id: mutation.rowId,
          cells: mutation.cells,
        },
      ];
    case "delete_rows":
      return [{ op: "delete_rows", row_ids: mutation.rowIds }];
    case "set_view":
      return [{ op: "set_view", ...toApiViewFields(mutation.view) }];
    case "save_view":
      return [
        {
          op: "save_view",
          name: mutation.view.name,
          ...toApiViewFields(mutation.view),
        },
      ];
    case "switch_view":
      return [{ op: "switch_view", view_id: mutation.viewId }];
    case "rename_view":
      return [
        { op: "save_view", view_id: mutation.viewId, name: mutation.name },
      ];
    case "delete_view":
      return [{ op: "delete_view", view_id: mutation.viewId }];
  }
}

export function listTables(): Promise<TableSummary[]> {
  return api
    .get<ApiTableSummary[]>("/v1/tables")
    .then((rows) => rows.map(fromApiSummary));
}

export function createTable(input?: { title?: string }): Promise<TableDoc> {
  return api
    .post<ApiTableDetail>("/v1/tables", { title: input?.title ?? null })
    .then(fromApiTable);
}

export function getTable(id: string): Promise<TableDoc> {
  return api
    .get<ApiTableDetail>(`/v1/tables/${encodeURIComponent(id)}`)
    .then(fromApiTable);
}

export function renameTable(id: string, title: string): Promise<TableSummary> {
  return api
    .patch<ApiTableSummary>(`/v1/tables/${encodeURIComponent(id)}`, { title })
    .then(fromApiSummary);
}

export async function deleteTable(id: string): Promise<void> {
  await api.delete(`/v1/tables/${encodeURIComponent(id)}`);
}

export function ensureTableConversation(
  id: string,
): Promise<{ conversationId: string }> {
  return api
    .post<{ conversation_id: string }>(
      `/v1/tables/${encodeURIComponent(id)}/conversation`,
      {},
    )
    .then((raw) => ({ conversationId: raw.conversation_id }));
}

function fromApiOpsResult(raw: ApiTableOpsResult): TableOpsResult {
  return {
    ok: raw.ok,
    level: raw.level,
    summary: raw.summary,
    needsConfirmation: Boolean(raw.needs_confirmation),
    batchId: raw.batch_id ?? null,
    conflict: Boolean(raw.conflict),
    error: raw.error ?? null,
    table: raw.table ? fromApiTable(raw.table) : null,
  };
}

/** Human UI already confirmed — always `confirm: true` (add_column is L2). */
export function applyTableOps(
  id: string,
  ops: TableOp[],
  options?: { schemaBaseline?: number | null },
): Promise<TableOpsResult> {
  return api
    .post<ApiTableOpsResult>(`/v1/tables/${encodeURIComponent(id)}/ops`, {
      ops,
      confirm: true,
      schema_baseline: options?.schemaBaseline ?? null,
    })
    .then(fromApiOpsResult);
}

export function isTableConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}
