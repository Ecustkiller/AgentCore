import { IconButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { formatCell } from "./fieldMeta";
import type { ColumnDef, TableRow } from "./types";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function ymd(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseDay(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.slice(0, 10);
}

export function CalendarBoard({
  columns,
  rows,
  dateFieldId,
  titleFieldId,
  selectedIds,
  onToggleRow,
}: {
  columns: ColumnDef[];
  rows: TableRow[];
  dateFieldId: string;
  titleFieldId?: string;
  selectedIds: Set<string>;
  onToggleRow: (id: string) => void;
}) {
  const dateCol = columns.find((c) => c.id === dateFieldId);
  const title =
    columns.find((c) => c.id === titleFieldId) ??
    columns.find((c) => c.type === "text");
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const cells = useMemo(() => {
    const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startPad = start.getDay();
    const daysInMonth = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      0,
    ).getDate();
    const grid: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < startPad; i++) {
      const d = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        i - startPad + 1,
      );
      grid.push({ date: d, inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      grid.push({
        date: new Date(cursor.getFullYear(), cursor.getMonth(), d),
        inMonth: true,
      });
    }
    while (grid.length % 7 !== 0) {
      const last = grid[grid.length - 1].date;
      const n = new Date(last);
      n.setDate(n.getDate() + 1);
      grid.push({ date: n, inMonth: false });
    }
    return grid;
  }, [cursor]);

  const byDay = new Map<string, TableRow[]>();
  for (const row of rows) {
    const key = parseDay(row.cells[dateCol?.id ?? ""]);
    if (!key) continue;
    const list = byDay.get(key) ?? [];
    list.push(row);
    byDay.set(key, list);
  }

  const label = `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;

  return (
    <div className="absolute inset-0 flex flex-col p-3">
      <div className="mb-2 flex items-center gap-2">
        <IconButton
          aria-label="上个月"
          onClick={() =>
            setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))
          }
        >
          <ChevronLeft size={16} />
        </IconButton>
        <h2 className="text-sm font-medium">{label}</h2>
        <IconButton
          aria-label="下个月"
          onClick={() =>
            setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))
          }
        >
          <ChevronRight size={16} />
        </IconButton>
      </div>
      <div className="grid grid-cols-7 gap-px rounded-xl border border-border bg-border">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="bg-background py-1.5 text-center text-xs text-muted-foreground"
          >
            {d}
          </div>
        ))}
        {cells.map(({ date, inMonth }) => {
          const key = ymd(date);
          const items = byDay.get(key) ?? [];
          const open = expanded.has(key);
          const visible = open ? items : items.slice(0, 3);
          const rest = items.length - visible.length;
          return (
            <div
              key={key}
              className={`min-h-[5.5rem] bg-background p-1 ${inMonth ? "" : "opacity-40"}`}
            >
              <div className="px-1 text-xs text-muted-foreground">
                {date.getDate()}
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {visible.map((row) => {
                  const selected = selectedIds.has(row.id);
                  return (
                    <button
                      key={row.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onToggleRow(row.id)}
                      className={cn(
                        "truncate rounded-lg px-1 py-0.5 text-left text-xs text-foreground",
                        selected
                          ? "bg-primary/25 ring-1 ring-ring"
                          : "bg-primary/10",
                      )}
                    >
                      {title
                        ? formatCell(title, row.cells[title.id] ?? null) ||
                          "未命名"
                        : key}
                    </button>
                  );
                })}
                {rest > 0 ? (
                  <button
                    type="button"
                    className="px-1 text-left text-xs text-muted-foreground"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        next.add(key);
                        return next;
                      })
                    }
                  >
                    +{rest}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
