export const FIELD_TYPES = [
  "text",
  "number",
  "singleSelect",
  "multiSelect",
  "date",
  "datetime",
  "checkbox",
  "url",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type DisplayMode = "table" | "kanban" | "calendar" | "gallery";

export type Density = "compact" | "comfortable" | "loose";

export const OPTION_TONES = ["gray", "blue", "green", "orange", "red"] as const;

export type OptionTone = (typeof OPTION_TONES)[number];

export interface SelectOption {
  id: string;
  label: string;
  tone?: OptionTone;
}

export interface ColumnDef {
  id: string;
  label: string;
  type: FieldType;
  options?: SelectOption[];
}

export type CellValue = string | number | boolean | string[] | null;

export interface TableRow {
  id: string;
  cells: Record<string, CellValue>;
  position: number;
}

export type FilterOp =
  | "contains"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "empty"
  | "not_empty"
  | "any_of";

export interface FilterClause {
  id: string;
  columnId: string;
  op: FilterOp;
  value: CellValue;
}

export interface SortClause {
  columnId: string;
  dir: "asc" | "desc";
}

export interface ModeConfig {
  groupField?: string;
  dateField?: string;
  titleField?: string;
  subtitleFields?: string[];
  cardFields?: string[];
}

export interface ViewConfig {
  filters: FilterClause[];
  sort: SortClause | null;
  groupBy: string | null;
  hiddenColumnIds: string[];
  density: Density;
  modeConfig: ModeConfig;
}

export interface TableView {
  id: string;
  name: string;
  displayMode: DisplayMode;
  config: ViewConfig;
  isDefault?: boolean;
}

export interface TableDoc {
  id: string;
  title: string;
  columns: ColumnDef[];
  rows: TableRow[];
  views: TableView[];
  activeViewId: string;
  schemaVersion: number;
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ROW_LIMIT = 5000;

export function emptyViewConfig(): ViewConfig {
  return {
    filters: [],
    sort: null,
    groupBy: null,
    hiddenColumnIds: [],
    density: "comfortable",
    modeConfig: {},
  };
}
