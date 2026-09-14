import { cn } from "@/lib/utils";
import { type DragEvent, useRef } from "react";
import { CellDisplay } from "./cells";
import { formatCell } from "./fieldMeta";
import type { ColumnDef, TableRow } from "./types";

export function KanbanBoard({
  columns,
  rows,
  groupFieldId,
  titleFieldId,
  selectedIds,
  onToggleRow,
  onMove,
}: {
  columns: ColumnDef[];
  rows: TableRow[];
  groupFieldId: string;
  titleFieldId?: string;
  selectedIds: Set<string>;
  onToggleRow: (id: string) => void;
  onMove: (rowId: string, optionId: string) => void;
}) {
  const group = columns.find((c) => c.id === groupFieldId);
  const title =
    columns.find((c) => c.id === titleFieldId) ??
    columns.find((c) => c.type === "text");
  const dragging = useRef(false);
  if (!group || group.type !== "singleSelect") return null;
  const chipCols = columns.filter(
    (c) =>
      c.id !== title?.id &&
      c.id !== group.id &&
      (c.type === "singleSelect" || c.type === "multiSelect"),
  );
  const dateCol = columns.find(
    (c) => c.id !== group.id && (c.type === "date" || c.type === "datetime"),
  );
  const options = group.options ?? [];
  const byOpt = new Map<string, TableRow[]>();
  for (const opt of options) byOpt.set(opt.id, []);
  const unfiled: TableRow[] = [];
  for (const row of rows) {
    const key =
      typeof row.cells[group.id] === "string"
        ? String(row.cells[group.id])
        : "";
    const bucket = byOpt.get(key);
    if (bucket) bucket.push(row);
    else unfiled.push(row);
  }
  const lanes = [
    ...options.map((o) => ({
      id: o.id,
      label: o.label,
      rows: byOpt.get(o.id) ?? [],
    })),
    ...(unfiled.length ? [{ id: "", label: "未填写", rows: unfiled }] : []),
  ];

  const onDrop = (optionId: string) => (e: DragEvent) => {
    e.preventDefault();
    const rowId = e.dataTransfer.getData("text/row-id");
    if (rowId && optionId) onMove(rowId, optionId);
  };

  return (
    <div className="absolute inset-0 overflow-auto p-3">
      <div className="flex min-h-full gap-3">
        {lanes.map((lane) => (
          <section
            key={lane.id || "empty"}
            className="flex w-64 shrink-0 flex-col rounded-xl border border-border bg-muted/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop(lane.id)}
          >
            <header className="flex items-center justify-between px-3 py-2">
              <h2 className="text-xs font-medium text-foreground">
                {lane.label}
              </h2>
              <span className="text-xs text-muted-foreground">
                {lane.rows.length}
              </span>
            </header>
            <div className="flex flex-1 flex-col gap-2 p-2 pt-0">
              {lane.rows.map((row) => {
                const selected = selectedIds.has(row.id);
                return (
                  <article
                    key={row.id}
                    draggable
                    aria-selected={selected}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: kanban card is selectable via keyboard as well as click
                    tabIndex={0}
                    onDragStart={(e) => {
                      dragging.current = true;
                      e.dataTransfer.setData("text/row-id", row.id);
                    }}
                    onDragEnd={() => {
                      window.setTimeout(() => {
                        dragging.current = false;
                      }, 0);
                    }}
                    onClick={() => {
                      if (dragging.current) return;
                      onToggleRow(row.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      if (dragging.current) return;
                      onToggleRow(row.id);
                    }}
                    className={cn(
                      "cursor-grab rounded-lg border bg-card p-3 shadow-sm",
                      selected
                        ? "border-ring ring-1 ring-ring"
                        : "border-border",
                    )}
                  >
                    <p className="text-sm font-medium text-foreground">
                      {title
                        ? formatCell(title, row.cells[title.id] ?? null) ||
                          "未命名"
                        : row.id}
                    </p>
                    {dateCol ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatCell(dateCol, row.cells[dateCol.id] ?? null)}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {chipCols.map((c) => (
                        <CellDisplay
                          key={c.id}
                          column={c}
                          value={row.cells[c.id] ?? null}
                        />
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
