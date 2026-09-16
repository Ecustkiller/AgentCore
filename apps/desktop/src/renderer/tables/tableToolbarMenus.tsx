import { Button, Input, Select } from "@/components/ui";
import { Switch } from "@/components/ui/Switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Columns3, Filter, Plus } from "lucide-react";
import { useState } from "react";
import {
  FIELD_TYPE_LABELS,
  formatCell,
  isSortable,
  operatorsFor,
} from "./fieldMeta";
import { newId } from "./ids";
import type {
  CellValue,
  ColumnDef,
  FieldType,
  FilterClause,
  TableView,
} from "./types";
import { FIELD_TYPES } from "./types";

export function FieldMenu({
  columns,
  hidden,
  onAdd,
  onToggle,
}: {
  columns: ColumnDef[];
  hidden: Set<string>;
  onAdd: (label: string, type: FieldType) => void;
  onToggle: (columnId: string, hidden: boolean) => void;
}) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const hiddenCount = hidden.size;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="neutral"
          size="sm"
          icon={<Columns3 size={14} />}
          aria-label={hiddenCount ? `字段，已隐藏 ${hiddenCount} 列` : "字段"}
        >
          字段
          {hiddenCount > 0 ? (
            <span className="ml-0.5 tabular-nums text-muted-foreground">
              {hiddenCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">显示列</p>
        <div className="flex flex-col gap-1.5">
          {columns.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="truncate">{c.label}</span>
              <Switch
                label={`显示${c.label}`}
                checked={!hidden.has(c.id)}
                onCheckedChange={(on) => onToggle(c.id, !on)}
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <Input
            placeholder="新列名称"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as FieldType)}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onAdd(label, type);
              setLabel("");
            }}
          >
            添加列
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FilterMenu({
  columns,
  filters,
  onChange,
}: {
  columns: ColumnDef[];
  filters: FilterClause[];
  onChange: (filters: FilterClause[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={filters.length ? "outline" : "neutral"}
          size="sm"
          icon={<Filter size={14} />}
        >
          筛选{filters.length ? ` ${filters.length}` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <div className="flex flex-col gap-2">
          {filters.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有条件</p>
          ) : null}
          {filters.map((clause) => {
            const col =
              columns.find((c) => c.id === clause.columnId) ?? columns[0];
            const ops = operatorsFor(col.type);
            const needsValue =
              clause.op !== "empty" && clause.op !== "not_empty";
            return (
              <div key={clause.id} className="flex items-start gap-1">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex gap-1">
                    <Select
                      className="flex-1"
                      value={clause.columnId}
                      onChange={(e) =>
                        onChange(
                          filters.map((f) =>
                            f.id === clause.id
                              ? {
                                  ...f,
                                  columnId: e.target.value,
                                  op: "eq",
                                  value: null,
                                }
                              : f,
                          ),
                        )
                      }
                    >
                      {columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                    <Select
                      className="w-24"
                      value={clause.op}
                      onChange={(e) =>
                        onChange(
                          filters.map((f) =>
                            f.id === clause.id
                              ? {
                                  ...f,
                                  op: e.target.value as FilterClause["op"],
                                }
                              : f,
                          ),
                        )
                      }
                    >
                      {ops.map((o) => (
                        <option key={o.op} value={o.op}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {needsValue ? (
                    <FilterValueField
                      column={col}
                      value={clause.value}
                      onChange={(value) =>
                        onChange(
                          filters.map((f) =>
                            f.id === clause.id ? { ...f, value } : f,
                          ),
                        )
                      }
                    />
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="移除条件"
                  onClick={() =>
                    onChange(filters.filter((f) => f.id !== clause.id))
                  }
                >
                  移除
                </Button>
              </div>
            );
          })}
          <Button
            variant="neutral"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() =>
              onChange([
                ...filters,
                {
                  id: newId(),
                  columnId: columns[0]?.id ?? "",
                  op: "contains",
                  value: "",
                },
              ])
            }
          >
            添加条件
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterValueField({
  column,
  value,
  onChange,
}: {
  column: ColumnDef;
  value: CellValue;
  onChange: (value: CellValue) => void;
}) {
  if (column.type === "singleSelect" || column.type === "multiSelect") {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">选择</option>
        {(column.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      value={value == null || Array.isArray(value) ? "" : String(value)}
      onChange={(e) =>
        onChange(
          column.type === "number"
            ? e.target.value === ""
              ? null
              : Number(e.target.value)
            : e.target.value,
        )
      }
    />
  );
}

export function SortMenu({
  columns,
  sort,
  onChange,
}: {
  columns: ColumnDef[];
  sort: TableView["config"]["sort"];
  onChange: (columnId: string | null, dir: "asc" | "desc") => void;
}) {
  const sortable = columns.filter((c) => isSortable(c.type));
  const current = sort
    ? sortable.find((c) => c.id === sort.columnId)
    : undefined;
  const label = current
    ? `排序 · ${current.label}${sort?.dir === "desc" ? "↓" : "↑"}`
    : "排序";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={sort ? "outline" : "neutral"} size="sm">
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onChange(null, "asc")}>
          手动顺序
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {sortable.map((c) => {
          const active = sort?.columnId === c.id;
          const dir = active && sort?.dir === "desc" ? "desc" : "asc";
          return (
            <DropdownMenuItem
              key={c.id}
              onSelect={() =>
                onChange(c.id, active && sort?.dir === "asc" ? "desc" : "asc")
              }
            >
              {c.label}
              {active ? (dir === "desc" ? " ↓" : " ↑") : ""}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function GroupMenu({
  columns,
  groupBy,
  onChange,
}: {
  columns: ColumnDef[];
  groupBy: string | null;
  onChange: (columnId: string | null) => void;
}) {
  const groupable = columns.filter(
    (c) =>
      c.type === "singleSelect" ||
      c.type === "multiSelect" ||
      c.type === "checkbox" ||
      c.type === "date",
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={groupBy ? "outline" : "neutral"} size="sm">
          分组{groupBy ? " · 开" : ""}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          不分组
        </DropdownMenuItem>
        {groupable.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => onChange(c.id)}>
            {c.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function batchDraft(column: ColumnDef | undefined): CellValue {
  if (!column) return null;
  if (column.type === "checkbox") return false;
  if (column.type === "multiSelect") return [];
  return null;
}

export function BatchFillMenu({
  columns,
  count,
  onApply,
}: {
  columns: ColumnDef[];
  count: number;
  onApply: (columnId: string, value: CellValue) => void;
}) {
  const [columnId, setColumnId] = useState(columns[0]?.id ?? "");
  const col = columns.find((c) => c.id === columnId) ?? columns[0];
  const [value, setValue] = useState<CellValue>(() => batchDraft(col));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="neutral" size="sm">
          改 {count} 行
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="flex flex-col gap-2">
          <Select
            aria-label="批量改列"
            value={col?.id ?? ""}
            onChange={(e) => {
              const next = columns.find((c) => c.id === e.target.value);
              setColumnId(e.target.value);
              setValue(batchDraft(next));
            }}
          >
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
          {col ? (
            <BatchValueField column={col} value={value} onChange={setValue} />
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={!col}
            onClick={() => {
              if (col) onApply(col.id, value);
            }}
          >
            应用到 {count} 行
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BatchValueField({
  column,
  value,
  onChange,
}: {
  column: ColumnDef;
  value: CellValue;
  onChange: (value: CellValue) => void;
}) {
  if (column.type === "checkbox") {
    return (
      <Select
        aria-label="批量填写"
        value={value ? "1" : "0"}
        onChange={(e) => onChange(e.target.value === "1")}
      >
        <option value="0">未勾选</option>
        <option value="1">已勾选</option>
      </Select>
    );
  }
  if (column.type === "singleSelect") {
    return (
      <Select
        aria-label="批量填写"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">未填写</option>
        {(column.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (column.type === "multiSelect") {
    const current = Array.isArray(value) ? (value[0] ?? "") : "";
    return (
      <Select
        aria-label="批量填写"
        value={current}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
      >
        <option value="">未填写</option>
        {(column.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (column.type === "date" || column.type === "datetime") {
    return (
      <Input
        aria-label="批量填写"
        type={column.type === "datetime" ? "datetime-local" : "date"}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  if (column.type === "number") {
    return (
      <Input
        aria-label="批量填写"
        type="number"
        value={typeof value === "number" ? String(value) : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    );
  }
  return (
    <Input
      aria-label="批量填写"
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function filterChipLabel(
  clause: FilterClause,
  columns: ColumnDef[],
): string {
  const col = columns.find((c) => c.id === clause.columnId);
  if (!col) return "筛选";
  const op = operatorsFor(col.type).find((o) => o.op === clause.op);
  const opLabel = op?.label ?? clause.op;
  if (clause.op === "empty" || clause.op === "not_empty") {
    return `${col.label} ${opLabel}`;
  }
  const value = formatCell(col, clause.value);
  return value ? `${col.label} ${opLabel} ${value}` : `${col.label} ${opLabel}`;
}
