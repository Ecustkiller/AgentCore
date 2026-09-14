import { Button, EmptyHint, Select } from "@/components/ui";
import { notifyError } from "@/lib/toast";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { CalendarBoard } from "./CalendarBoard";
import { GalleryBoard } from "./GalleryBoard";
import { KanbanBoard } from "./KanbanBoard";
import { TableGrid } from "./TableGrid";
import { TableToolbar } from "./TableToolbar";
import { DISPLAY_MODE_LABELS } from "./fieldMeta";
import {
  candidateColumnsForMode,
  groupRows,
  queryRows,
  resolveModeConfig,
  searchRows,
  visibleColumns,
} from "./query";
import { activeViewOf, useTablesStore } from "./store";
import type { ColumnDef, DisplayMode, TableDoc, TableRow } from "./types";

export function TableEditor({
  table,
  onSelectionChange,
}: {
  table: TableDoc;
  onSelectionChange?: (rowIds: string[]) => void;
}) {
  const addRow = useTablesStore((s) => s.addRow);
  const addColumn = useTablesStore((s) => s.addColumn);
  const updateColumn = useTablesStore((s) => s.updateColumn);
  const removeColumn = useTablesStore((s) => s.removeColumn);
  const updateCell = useTablesStore((s) => s.updateCell);
  const deleteRows = useTablesStore((s) => s.deleteRows);
  const patchView = useTablesStore((s) => s.patchView);
  const setDisplayMode = useTablesStore((s) => s.setDisplayMode);
  const switchView = useTablesStore((s) => s.switchView);
  const addView = useTablesStore((s) => s.addView);
  const renameView = useTablesStore((s) => s.renameView);
  const deleteView = useTablesStore((s) => s.deleteView);

  const view = activeViewOf(table);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    onSelectionChange?.([...selected]);
  }, [onSelectionChange, selected]);

  const queried = useMemo(() => {
    const rows = queryRows(table.rows, table.columns, view.config);
    return searchRows(rows, table.columns, search);
  }, [search, table.columns, table.rows, view.config]);

  const columns = visibleColumns(table.columns, view.config.hiddenColumnIds);
  const mode = resolveModeConfig(view, columns);
  const groups =
    view.displayMode === "table"
      ? groupRows(queried, table.columns, view.config.groupBy)
      : null;

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const assignModeField = (columnId: string) => {
    const modeConfig = { ...view.config.modeConfig };
    if (view.displayMode === "kanban") modeConfig.groupField = columnId;
    if (view.displayMode === "calendar") modeConfig.dateField = columnId;
    if (view.displayMode === "gallery") modeConfig.titleField = columnId;
    const hidden = view.config.hiddenColumnIds.filter((id) => id !== columnId);
    patchView(table.id, view.id, { modeConfig, hiddenColumnIds: hidden });
  };

  const grid = (
    rows: TableRow[],
    opts?: { fill?: boolean; showAddRow?: boolean },
  ) => (
    <TableGrid
      columns={columns}
      rows={rows}
      density={view.config.density}
      selectedIds={selected}
      onToggleRow={toggleRow}
      onToggleAll={() => {
        setSelected((prev) =>
          rows.every((r) => prev.has(r.id))
            ? new Set()
            : new Set(rows.map((r) => r.id)),
        );
      }}
      onUpdateCell={(rowId, columnId, value) =>
        updateCell(table.id, rowId, columnId, value)
      }
      onAddRow={() => {
        const result = addRow(table.id);
        if (!result.ok) notifyError("一张表最多 5000 行");
      }}
      onUpdateColumn={(columnId, patch) =>
        updateColumn(table.id, columnId, patch)
      }
      onHideColumn={(columnId) => {
        const ids = new Set(view.config.hiddenColumnIds);
        ids.add(columnId);
        patchView(table.id, view.id, { hiddenColumnIds: [...ids] });
      }}
      onRemoveColumn={(columnId) => removeColumn(table.id, columnId)}
      onSort={(columnId, dir) =>
        patchView(table.id, view.id, { sort: { columnId, dir } })
      }
      fill={opts?.fill ?? true}
      showAddRow={opts?.showAddRow ?? true}
    />
  );

  let body: ReactNode;
  if (!mode.ok) {
    body = (
      <ModeRepair
        mode={view.displayMode}
        columns={table.columns}
        onPick={assignModeField}
        onAdd={() => {
          let id: string | undefined;
          if (view.displayMode === "kanban") {
            id = addColumn(table.id, "状态", "singleSelect");
          }
          if (view.displayMode === "calendar") {
            id = addColumn(table.id, "日期", "date");
          }
          if (view.displayMode === "gallery") {
            id = addColumn(table.id, "标题", "text");
          }
          if (id) assignModeField(id);
        }}
      />
    );
  } else if (view.displayMode === "kanban" && mode.groupField) {
    body = (
      <KanbanBoard
        columns={columns}
        rows={queried}
        groupFieldId={mode.groupField}
        titleFieldId={mode.titleField}
        selectedIds={selected}
        onToggleRow={toggleRow}
        onMove={(rowId, optionId) => {
          const field = mode.groupField;
          if (!field) return;
          updateCell(table.id, rowId, field, optionId);
        }}
      />
    );
  } else if (view.displayMode === "calendar" && mode.dateField) {
    body = (
      <CalendarBoard
        columns={columns}
        rows={queried}
        dateFieldId={mode.dateField}
        titleFieldId={mode.titleField}
        selectedIds={selected}
        onToggleRow={toggleRow}
      />
    );
  } else if (view.displayMode === "gallery" && mode.titleField) {
    body = (
      <GalleryBoard
        columns={columns}
        rows={queried}
        titleFieldId={mode.titleField}
        subtitleFieldIds={mode.subtitleFields}
        selectedIds={selected}
        onToggleRow={toggleRow}
      />
    );
  } else if (groups) {
    body = (
      <div className="absolute inset-0 overflow-auto">
        {groups.map((g) => (
          <section key={g.key || "empty"} className="relative min-h-[8rem]">
            <h2 className="sticky top-0 z-20 border-b border-border bg-background px-3 py-1.5 text-xs font-medium">
              {g.label}
              <span className="ml-2 text-muted-foreground">
                {g.rows.length}
              </span>
            </h2>
            <div className="relative h-auto">
              {grid(g.rows, { fill: false, showAddRow: false })}
            </div>
          </section>
        ))}
      </div>
    );
  } else {
    body = grid(queried);
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <TableToolbar
        table={table}
        view={view}
        search={search}
        selectedCount={selected.size}
        onSearch={setSearch}
        onAddRow={() => {
          const result = addRow(table.id);
          if (!result.ok) notifyError("一张表最多 5000 行");
        }}
        onAddColumn={(label, type) => addColumn(table.id, label, type)}
        onToggleColumn={(columnId, hidden) => {
          const ids = new Set(view.config.hiddenColumnIds);
          if (hidden) ids.add(columnId);
          else ids.delete(columnId);
          patchView(table.id, view.id, { hiddenColumnIds: [...ids] });
        }}
        onPatchFilters={(filters) => patchView(table.id, view.id, { filters })}
        onSort={(columnId, dir) =>
          patchView(table.id, view.id, {
            sort: columnId ? { columnId, dir } : null,
          })
        }
        onGroup={(columnId) =>
          patchView(table.id, view.id, { groupBy: columnId })
        }
        onDensity={(density) => patchView(table.id, view.id, { density })}
        onMode={(m: DisplayMode) => setDisplayMode(table.id, m)}
        onSwitchView={(id) => switchView(table.id, id)}
        onAddView={() => addView(table.id, "未命名视图")}
        onRenameView={(id, name) => renameView(table.id, id, name)}
        onDeleteView={(id) => deleteView(table.id, id)}
        onBatchDelete={() => {
          deleteRows(table.id, [...selected]);
          setSelected(new Set());
        }}
        onBatchFill={(columnId, value) => {
          for (const id of selected) updateCell(table.id, id, columnId, value);
        }}
      />
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

function ModeRepair({
  mode,
  columns,
  onPick,
  onAdd,
}: {
  mode: DisplayMode;
  columns: ColumnDef[];
  onPick: (columnId: string) => void;
  onAdd: () => void;
}) {
  const candidates = candidateColumnsForMode(mode, columns);
  const [picked, setPicked] = useState(candidates[0]?.id ?? "");
  const fieldLabel =
    mode === "kanban" ? "分组列" : mode === "calendar" ? "日期列" : "标题列";
  return (
    <EmptyHint
      className="mt-16"
      title={`「${DISPLAY_MODE_LABELS[mode]}」需要${fieldLabel}`}
      action={
        candidates.length > 0 ? (
          <div className="flex items-center gap-2">
            <Select
              aria-label={fieldLabel}
              className="w-40"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={!picked}
              onClick={() => onPick(picked)}
            >
              使用此列
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={onAdd}>
            添加需要的列
          </Button>
        )
      }
    />
  );
}
