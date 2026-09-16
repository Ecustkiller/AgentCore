import { IconButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { ColumnHeader } from "./ColumnHeader";
import { CellDisplay, CellEditor } from "./cells";
import { formatCell, parsePasted } from "./fieldMeta";
import type { CellValue, ColumnDef, Density, TableRow } from "./types";
import { COLUMN_WIDTH_DEFAULT, clampColumnWidth } from "./types";

const ROW_H: Record<Density, string> = {
  compact: "h-7",
  comfortable: "h-9",
  loose: "h-12",
};

const SELECT_COL_W = 40;

type CellRef = { rowId: string; columnId: string };

export function TableGrid({
  columns,
  rows,
  density,
  selectedIds,
  columnWidths = {},
  onToggleRow,
  onToggleAll,
  onUpdateCell,
  onAddRow,
  onAddColumn,
  onUpdateColumn,
  onHideColumn,
  onRemoveColumn,
  onSort,
  onColumnWidth,
  fill = true,
  showAddRow = true,
}: {
  columns: ColumnDef[];
  rows: TableRow[];
  density: Density;
  selectedIds: Set<string>;
  columnWidths?: Record<string, number>;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onUpdateCell: (rowId: string, columnId: string, value: CellValue) => void;
  onAddRow: () => void;
  onAddColumn?: () => void;
  onUpdateColumn: (columnId: string, patch: Partial<ColumnDef>) => void;
  onHideColumn: (columnId: string) => void;
  onRemoveColumn: (columnId: string) => void;
  onSort: (columnId: string, dir: "asc" | "desc") => void;
  onColumnWidth?: (columnId: string, width: number) => void;
  fill?: boolean;
  showAddRow?: boolean;
}) {
  const [editing, setEditing] = useState<CellRef | null>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [draft, setDraft] = useState<CellValue>(null);
  const [drag, setDrag] = useState<{ id: string; width: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rowH = ROW_H[density];
  const allOn = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));

  const widthOf = useCallback(
    (id: string) =>
      drag?.id === id ? drag.width : (columnWidths[id] ?? COLUMN_WIDTH_DEFAULT),
    [columnWidths, drag],
  );

  const tableWidth =
    SELECT_COL_W +
    columns.reduce((sum, col) => sum + widthOf(col.id), 0) +
    (onAddColumn ? SELECT_COL_W : 0);

  const selectCell = useCallback((next: CellRef) => {
    setSelected(next);
    gridRef.current?.focus();
  }, []);

  const beginEdit = useCallback(
    (row: TableRow, column: ColumnDef) => {
      if (editing) onUpdateCell(editing.rowId, editing.columnId, draft);
      setSelected({ rowId: row.id, columnId: column.id });
      setEditing({ rowId: row.id, columnId: column.id });
      setDraft(
        row.cells[column.id] ?? (column.type === "checkbox" ? false : null),
      );
    },
    [draft, editing, onUpdateCell],
  );

  const commit = useCallback(
    (next?: CellValue) => {
      if (!editing) return;
      onUpdateCell(
        editing.rowId,
        editing.columnId,
        next !== undefined ? next : draft,
      );
      setEditing(null);
    },
    [draft, editing, onUpdateCell],
  );

  const cancel = useCallback(() => setEditing(null), []);

  const move = useCallback(
    (dr: number, dc: number) => {
      if (!selected || columns.length === 0 || rows.length === 0) return;
      const r = rows.findIndex((row) => row.id === selected.rowId);
      const c = columns.findIndex((col) => col.id === selected.columnId);
      if (r < 0 || c < 0) return;
      let nr = r + dr;
      let nc = c + dc;
      if (dc !== 0 && dr === 0) {
        if (nc >= columns.length) {
          nr += 1;
          nc = 0;
        } else if (nc < 0) {
          nr -= 1;
          nc = columns.length - 1;
        }
      }
      if (nr < 0 || nr >= rows.length) return;
      nc = Math.max(0, Math.min(columns.length - 1, nc));
      selectCell({ rowId: rows[nr].id, columnId: columns[nc].id });
    },
    [columns, rows, selectCell, selected],
  );

  const clearSelected = useCallback(() => {
    if (!selected) return;
    const col = columns.find((c) => c.id === selected.columnId);
    if (!col) return;
    onUpdateCell(
      selected.rowId,
      selected.columnId,
      col.type === "checkbox" ? false : col.type === "multiSelect" ? [] : null,
    );
  }, [columns, onUpdateCell, selected]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (!selected) return;
    const col = columns.find((c) => c.id === selected.columnId);
    const row = rows.find((r) => r.id === selected.rowId);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1, 0);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1, 0);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      move(0, -1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      move(0, 1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      move(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!col || !row) return;
      if (col.type === "checkbox") {
        onUpdateCell(row.id, col.id, !row.cells[col.id]);
      } else if (e.key === "Enter") {
        beginEdit(row, col);
      }
    } else if (e.key === "Escape") {
      setSelected(null);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      clearSelected();
    }
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selected) return;
    const col = columns.find((c) => c.id === selected.columnId);
    const row = rows.find((r) => r.id === selected.rowId);
    if (!col || !row) return;
    e.preventDefault();
    e.clipboardData.setData(
      "text/plain",
      formatCell(col, row.cells[col.id] ?? null),
    );
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selected) return;
    const col = columns.find((c) => c.id === selected.columnId);
    if (!col) return;
    e.preventDefault();
    onUpdateCell(
      selected.rowId,
      selected.columnId,
      parsePasted(col, e.clipboardData.getData("text/plain")),
    );
  };

  const startResize = (
    columnId: string,
    e: PointerEvent<HTMLButtonElement>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(columnId);
    const onMove = (ev: globalThis.PointerEvent) => {
      setDrag({
        id: columnId,
        width: clampColumnWidth(startW + ev.clientX - startX),
      });
    };
    const onUp = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const next = clampColumnWidth(startW + ev.clientX - startX);
      setDrag(null);
      onColumnWidth?.(columnId, next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const stickyBg = (rowId?: string) =>
    cn(
      "bg-background",
      rowId && selectedIds.has(rowId) && "bg-primary/5",
      rowId && "group-hover:bg-accent/60",
    );

  return (
    <div
      ref={gridRef}
      // biome-ignore lint/a11y/useSemanticElements: spreadsheet keyboard owner; inner <table> is layout
      role="grid"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: grid widget must take focus for arrow-key cell movement
      tabIndex={0}
      aria-label="表格"
      className={cn(
        "outline-none",
        fill ? "absolute inset-0 overflow-auto" : "overflow-auto",
      )}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
    >
      <table
        className="border-collapse text-sm"
        style={{ tableLayout: "fixed", width: tableWidth }}
      >
        <colgroup>
          <col style={{ width: SELECT_COL_W }} />
          {columns.map((col) => (
            <col key={col.id} style={{ width: widthOf(col.id) }} />
          ))}
          {onAddColumn ? <col style={{ width: SELECT_COL_W }} /> : null}
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr className="border-b border-border">
            <th
              className="sticky left-0 z-20 bg-background px-2"
              style={{ width: SELECT_COL_W }}
            >
              <input
                type="checkbox"
                aria-label="全选"
                className="size-3.5 accent-[var(--primary)]"
                checked={allOn}
                onChange={onToggleAll}
              />
            </th>
            {columns.map((col, index) => (
              <th
                key={col.id}
                className={cn(
                  "relative bg-background px-2 py-2 text-left",
                  index === 0 && "sticky z-20",
                )}
                style={
                  index === 0
                    ? { left: SELECT_COL_W, width: widthOf(col.id) }
                    : { width: widthOf(col.id) }
                }
              >
                <ColumnHeader
                  column={col}
                  canDelete={columns.length > 1}
                  onUpdate={(patch) => onUpdateColumn(col.id, patch)}
                  onHide={() => onHideColumn(col.id)}
                  onRemove={() => onRemoveColumn(col.id)}
                  onSort={(dir) => onSort(col.id, dir)}
                />
                {onColumnWidth ? (
                  <button
                    type="button"
                    aria-label={`调整${col.label}列宽`}
                    className="absolute top-0 right-0 z-30 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                    onPointerDown={(e) => startResize(col.id, e)}
                  />
                ) : null}
              </th>
            ))}
            {onAddColumn ? (
              <th className="bg-background px-1">
                <IconButton size="sm" aria-label="添加列" onClick={onAddColumn}>
                  <Plus size={14} />
                </IconButton>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                "group border-b border-border/70 hover:bg-accent/60",
                selectedIds.has(row.id) && "bg-primary/5",
              )}
            >
              <td
                className={cn(
                  "sticky left-0 z-[1] px-2",
                  rowH,
                  stickyBg(row.id),
                )}
                style={{ width: SELECT_COL_W }}
              >
                <input
                  type="checkbox"
                  aria-label="选择行"
                  className="size-3.5 accent-[var(--primary)]"
                  checked={selectedIds.has(row.id)}
                  onChange={() => onToggleRow(row.id)}
                />
              </td>
              {columns.map((col, index) => {
                const isEdit =
                  editing?.rowId === row.id && editing.columnId === col.id;
                const isSel =
                  selected?.rowId === row.id && selected.columnId === col.id;
                return (
                  <td
                    key={col.id}
                    // biome-ignore lint/a11y/useSemanticElements lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA gridcell on td; native td is a table cell, not a spreadsheet cursor
                    role="gridcell"
                    aria-selected={isSel}
                    tabIndex={isSel ? 0 : -1}
                    className={cn(
                      "cursor-cell overflow-hidden px-2 select-none",
                      rowH,
                      index === 0 && "sticky z-[1]",
                      index === 0 && stickyBg(row.id),
                      isSel &&
                        !isEdit &&
                        "bg-primary/10 ring-1 ring-inset ring-ring",
                    )}
                    style={
                      index === 0
                        ? { left: SELECT_COL_W, width: widthOf(col.id) }
                        : { width: widthOf(col.id) }
                    }
                    onClick={() => {
                      if (isEdit) return;
                      selectCell({ rowId: row.id, columnId: col.id });
                    }}
                    onKeyDown={(e) => {
                      if (isEdit) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectCell({ rowId: row.id, columnId: col.id });
                      }
                    }}
                    onDoubleClick={() => beginEdit(row, col)}
                  >
                    {isEdit ? (
                      <CellEditor
                        column={col}
                        value={draft}
                        onChange={setDraft}
                        onCommit={commit}
                        onCancel={cancel}
                        onMove={(dir) => {
                          setEditing(null);
                          move(0, dir === "left" ? -1 : 1);
                        }}
                      />
                    ) : (
                      <div className="flex h-full items-center overflow-hidden">
                        <CellDisplay
                          column={col}
                          value={row.cells[col.id] ?? null}
                        />
                      </div>
                    )}
                  </td>
                );
              })}
              {onAddColumn ? <td className={rowH} /> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {showAddRow ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onAddRow}
        >
          <Plus size={14} />
          新建行
        </button>
      ) : null}
    </div>
  );
}
