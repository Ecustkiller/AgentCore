import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { ColumnHeader } from "./ColumnHeader";
import { CellDisplay, CellEditor } from "./cells";
import { formatCell, parsePasted } from "./fieldMeta";
import type { CellValue, ColumnDef, Density, TableRow } from "./types";

const ROW_H: Record<Density, string> = {
  compact: "h-7",
  comfortable: "h-9",
  loose: "h-12",
};

type CellRef = { rowId: string; columnId: string };

export function TableGrid({
  columns,
  rows,
  density,
  selectedIds,
  onToggleRow,
  onToggleAll,
  onUpdateCell,
  onAddRow,
  onUpdateColumn,
  onHideColumn,
  onRemoveColumn,
  onSort,
  fill = true,
  showAddRow = true,
}: {
  columns: ColumnDef[];
  rows: TableRow[];
  density: Density;
  selectedIds: Set<string>;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onUpdateCell: (rowId: string, columnId: string, value: CellValue) => void;
  onAddRow: () => void;
  onUpdateColumn: (columnId: string, patch: Partial<ColumnDef>) => void;
  onHideColumn: (columnId: string) => void;
  onRemoveColumn: (columnId: string) => void;
  onSort: (columnId: string, dir: "asc" | "desc") => void;
  fill?: boolean;
  showAddRow?: boolean;
}) {
  const [editing, setEditing] = useState<CellRef | null>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [draft, setDraft] = useState<CellValue>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rowH = ROW_H[density];
  const allOn = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));

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
      <table className="min-w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b border-border">
            <th className="w-10 px-2">
              <input
                type="checkbox"
                aria-label="全选"
                className="size-3.5 accent-[var(--primary)]"
                checked={allOn}
                onChange={onToggleAll}
              />
            </th>
            {columns.map((col) => (
              <th key={col.id} className="min-w-[10rem] px-2 py-2 text-left">
                <ColumnHeader
                  column={col}
                  canDelete={columns.length > 1}
                  onUpdate={(patch) => onUpdateColumn(col.id, patch)}
                  onHide={() => onHideColumn(col.id)}
                  onRemove={() => onRemoveColumn(col.id)}
                  onSort={(dir) => onSort(col.id, dir)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                "border-b border-border/70 hover:bg-accent/60",
                selectedIds.has(row.id) && "bg-primary/5",
              )}
            >
              <td className={cn("px-2", rowH)}>
                <input
                  type="checkbox"
                  aria-label="选择行"
                  className="size-3.5 accent-[var(--primary)]"
                  checked={selectedIds.has(row.id)}
                  onChange={() => onToggleRow(row.id)}
                />
              </td>
              {columns.map((col) => {
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
                      "max-w-[16rem] cursor-cell px-2 select-none",
                      rowH,
                      isSel &&
                        !isEdit &&
                        "bg-primary/10 ring-1 ring-inset ring-ring",
                    )}
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
                      <div className="flex h-full items-center">
                        <CellDisplay
                          column={col}
                          value={row.cells[col.id] ?? null}
                        />
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {showAddRow ? (
        <div className="p-2">
          <Button
            variant="neutral"
            size="sm"
            icon={<Plus size={14} />}
            onClick={onAddRow}
          >
            新建行
          </Button>
        </div>
      ) : null}
    </div>
  );
}
