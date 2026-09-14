import { newId } from "./ids";
import type {
  CellValue,
  ColumnDef,
  DisplayMode,
  FieldType,
  FilterOp,
  OptionTone,
} from "./types";

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "文本",
  number: "数字",
  singleSelect: "单选",
  multiSelect: "多选",
  date: "日期",
  datetime: "日期时间",
  checkbox: "勾选",
  url: "链接",
};

export const OPTION_TONE_CLASS: Record<OptionTone, string> = {
  gray: "bg-muted text-foreground",
  blue: "bg-primary/15 text-primary",
  green: "bg-success/15 text-foreground",
  orange: "bg-warning/15 text-foreground",
  red: "bg-destructive/15 text-destructive",
};

export const OPTION_TONE_LABELS: Record<OptionTone, string> = {
  gray: "灰",
  blue: "蓝",
  green: "绿",
  orange: "橙",
  red: "红",
};

export function defaultSelectOptions(): NonNullable<ColumnDef["options"]> {
  return [
    { id: newId(), label: "选项 A", tone: "gray" },
    { id: newId(), label: "选项 B", tone: "blue" },
    { id: newId(), label: "选项 C", tone: "green" },
  ];
}

export function parsePasted(column: ColumnDef, raw: string): CellValue {
  const text = raw.trim();
  if (column.type === "checkbox") {
    if (!text) return false;
    return /^(是|true|1|✓|yes)$/i.test(text);
  }
  if (!text) return null;
  if (column.type === "number") {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  if (column.type === "date") {
    const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  if (column.type === "datetime") {
    const m = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    return m ? m[1] : text;
  }
  if (column.type === "singleSelect") {
    const hit = column.options?.find((o) => o.id === text || o.label === text);
    return hit?.id ?? null;
  }
  if (column.type === "multiSelect") {
    const parts = text
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const ids = parts
      .map((p) => column.options?.find((o) => o.id === p || o.label === p)?.id)
      .filter((id): id is string => Boolean(id));
    return ids;
  }
  return text;
}

export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  table: "表格",
  kanban: "看板",
  calendar: "日历",
  gallery: "画廊",
};

export function operatorsFor(
  type: FieldType,
): { op: FilterOp; label: string }[] {
  switch (type) {
    case "number":
    case "date":
    case "datetime":
      return [
        { op: "eq", label: "等于" },
        { op: "gt", label: "大于" },
        { op: "lt", label: "小于" },
        { op: "empty", label: "为空" },
        { op: "not_empty", label: "有值" },
      ];
    case "singleSelect":
      return [
        { op: "eq", label: "是" },
        { op: "neq", label: "不是" },
        { op: "empty", label: "为空" },
        { op: "not_empty", label: "有值" },
      ];
    case "multiSelect":
      return [
        { op: "any_of", label: "包含" },
        { op: "empty", label: "为空" },
        { op: "not_empty", label: "有值" },
      ];
    case "checkbox":
      return [{ op: "eq", label: "等于" }];
    default:
      return [
        { op: "contains", label: "包含" },
        { op: "eq", label: "等于" },
        { op: "empty", label: "为空" },
        { op: "not_empty", label: "有值" },
      ];
  }
}

export function isGroupable(type: FieldType): boolean {
  return (
    type === "singleSelect" ||
    type === "multiSelect" ||
    type === "checkbox" ||
    type === "date"
  );
}

export function isSortable(type: FieldType): boolean {
  return type !== "url";
}

export function availableDisplayModes(columns: ColumnDef[]): DisplayMode[] {
  const modes: DisplayMode[] = ["table"];
  if (columns.some((c) => c.type === "singleSelect")) modes.push("kanban");
  if (columns.some((c) => c.type === "date" || c.type === "datetime")) {
    modes.push("calendar");
  }
  if (columns.some((c) => c.type === "text")) modes.push("gallery");
  return modes;
}

export function defaultTitleField(columns: ColumnDef[]): string | undefined {
  return columns.find((c) => c.type === "text")?.id;
}

export function defaultGroupField(columns: ColumnDef[]): string | undefined {
  return columns.find((c) => c.type === "singleSelect")?.id;
}

export function defaultDateField(columns: ColumnDef[]): string | undefined {
  return columns.find((c) => c.type === "date" || c.type === "datetime")?.id;
}

export function isEmptyValue(value: CellValue): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function optionLabel(
  column: ColumnDef,
  optionId: string | null | undefined,
): string {
  if (!optionId) return "";
  return column.options?.find((o) => o.id === optionId)?.label ?? optionId;
}

export function formatCell(column: ColumnDef, value: CellValue): string {
  if (isEmptyValue(value)) return "";
  if (column.type === "checkbox") return value ? "是" : "否";
  if (column.type === "singleSelect" && typeof value === "string") {
    return optionLabel(column, value);
  }
  if (column.type === "multiSelect" && Array.isArray(value)) {
    return value
      .map((id) => optionLabel(column, id))
      .filter(Boolean)
      .join("、");
  }
  if (column.type === "number" && typeof value === "number") {
    return String(value);
  }
  return String(value);
}

export function compareCell(
  type: FieldType,
  a: CellValue,
  b: CellValue,
): number {
  const aEmpty = isEmptyValue(a);
  const bEmpty = isEmptyValue(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (type === "number") {
    return Number(a) - Number(b);
  }
  if (type === "checkbox") {
    return Number(Boolean(a)) - Number(Boolean(b));
  }
  if (type === "multiSelect" && Array.isArray(a) && Array.isArray(b)) {
    return a.join().localeCompare(b.join(), "zh");
  }
  return String(a).localeCompare(String(b), "zh");
}

export function matchesFilter(
  column: ColumnDef,
  cell: CellValue,
  op: FilterOp,
  raw: CellValue,
): boolean {
  if (op === "empty") return isEmptyValue(cell);
  if (op === "not_empty") return !isEmptyValue(cell);
  if (op === "contains") {
    return String(cell ?? "")
      .toLowerCase()
      .includes(String(raw ?? "").toLowerCase());
  }
  if (op === "any_of") {
    const ids = Array.isArray(cell) ? cell : [];
    if (typeof raw === "string") return ids.includes(raw);
    if (Array.isArray(raw)) return raw.some((id) => ids.includes(id));
    return false;
  }
  if (op === "eq") {
    if (column.type === "checkbox") return Boolean(cell) === Boolean(raw);
    if (column.type === "number") return Number(cell) === Number(raw);
    return String(cell ?? "") === String(raw ?? "");
  }
  if (op === "neq") return String(cell ?? "") !== String(raw ?? "");
  const av = column.type === "number" ? Number(cell) : String(cell ?? "");
  const bv = column.type === "number" ? Number(raw) : String(raw ?? "");
  if (op === "gt") return av > bv;
  if (op === "gte") return av >= bv;
  if (op === "lt") return av < bv;
  if (op === "lte") return av <= bv;
  return true;
}
