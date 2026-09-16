import { Button, IconButton, Input, SearchField } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Calendar,
  Download,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Search,
  SquareKanban,
  Table2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DISPLAY_MODE_LABELS } from "./fieldMeta";
import { canUseMode } from "./query";
import {
  BatchFillMenu,
  FieldMenu,
  FilterMenu,
  GroupMenu,
  SortMenu,
  filterChipLabel,
} from "./tableToolbarMenus";
import type {
  CellValue,
  Density,
  DisplayMode,
  FieldType,
  FilterClause,
  TableDoc,
  TableView,
} from "./types";

const DENSITY_LABEL: Record<Density, string> = {
  compact: "紧凑",
  comfortable: "适中",
  loose: "宽松",
};

const MODE_ICON: Record<DisplayMode, typeof Table2> = {
  table: Table2,
  kanban: SquareKanban,
  calendar: Calendar,
  gallery: LayoutGrid,
};

function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />;
}

export function TableToolbar({
  table,
  view,
  search,
  selectedCount,
  onSearch,
  onAddRow,
  onAddColumn,
  onToggleColumn,
  onPatchFilters,
  onSort,
  onGroup,
  onDensity,
  onMode,
  onSwitchView,
  onAddView,
  onRenameView,
  onDeleteView,
  onBatchDelete,
  onBatchFill,
  onExport,
}: {
  table: TableDoc;
  view: TableView;
  search: string;
  selectedCount: number;
  onSearch: (q: string) => void;
  onAddRow: () => void;
  onAddColumn: (label: string, type: FieldType) => void;
  onToggleColumn: (columnId: string, hidden: boolean) => void;
  onPatchFilters: (filters: FilterClause[]) => void;
  onSort: (columnId: string | null, dir: "asc" | "desc") => void;
  onGroup: (columnId: string | null) => void;
  onDensity: (density: Density) => void;
  onMode: (mode: DisplayMode) => void;
  onSwitchView: (viewId: string) => void;
  onAddView: () => void;
  onRenameView: (viewId: string, name: string) => void;
  onDeleteView: (viewId: string) => void;
  onBatchDelete: () => void;
  onBatchFill: (columnId: string, value: CellValue) => void;
  onExport: () => void;
}) {
  const hidden = new Set(view.config.hiddenColumnIds);
  const modes = (["table", "kanban", "calendar", "gallery"] as const).filter(
    (m) => m === view.displayMode || canUseMode(m, table.columns),
  );
  const sortCol = view.config.sort
    ? table.columns.find((c) => c.id === view.config.sort?.columnId)
    : undefined;
  const groupCol = view.config.groupBy
    ? table.columns.find((c) => c.id === view.config.groupBy)
    : undefined;
  const hasChips =
    view.config.filters.length > 0 ||
    Boolean(view.config.sort) ||
    Boolean(view.config.groupBy);

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-1.5">
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          aria-label="新建记录"
          onClick={onAddRow}
        >
          新建
        </Button>
        <ToolbarDivider />
        <ViewTabs
          views={table.views}
          activeId={view.id}
          onSwitch={onSwitchView}
          onAdd={onAddView}
          onRename={onRenameView}
          onDelete={onDeleteView}
        />
        <ToolbarDivider />
        {selectedCount > 0 ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="px-1 text-xs text-muted-foreground">
              已选 {selectedCount}
            </span>
            <BatchFillMenu
              columns={table.columns}
              count={selectedCount}
              onApply={onBatchFill}
            />
            <Button variant="danger" size="sm" onClick={onBatchDelete}>
              删除 {selectedCount} 行
            </Button>
          </div>
        ) : (
          <>
            <FilterMenu
              columns={table.columns}
              filters={view.config.filters}
              onChange={onPatchFilters}
            />
            <SortMenu
              columns={table.columns}
              sort={view.config.sort}
              onChange={onSort}
            />
            <GroupMenu
              columns={table.columns}
              groupBy={view.config.groupBy}
              onChange={onGroup}
            />
            <SearchToggle value={search} onChange={onSearch} />
          </>
        )}
        <div className="min-w-2 flex-1" />
        <ModeStrip mode={view.displayMode} modes={modes} onChange={onMode} />
        <FieldMenu
          columns={table.columns}
          hidden={hidden}
          onAdd={onAddColumn}
          onToggle={onToggleColumn}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" aria-label="更多">
              <MoreHorizontal size={14} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.keys(DENSITY_LABEL) as Density[]).map((d) => (
              <DropdownMenuItem key={d} onSelect={() => onDensity(d)}>
                {view.config.density === d ? "✓ " : ""}
                {DENSITY_LABEL[d]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onExport}>
              <Download size={14} />
              导出 CSV
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hasChips ? (
        <div className="flex items-center gap-1 overflow-x-auto px-3 pb-1.5">
          {view.config.filters.map((clause) => {
            const label = filterChipLabel(clause, table.columns);
            return (
              <QueryChip
                key={clause.id}
                label={label}
                onRemove={() =>
                  onPatchFilters(
                    view.config.filters.filter((f) => f.id !== clause.id),
                  )
                }
              />
            );
          })}
          {sortCol && view.config.sort ? (
            <QueryChip
              label={`排序 · ${sortCol.label}${view.config.sort.dir === "desc" ? "↓" : "↑"}`}
              onRemove={() => onSort(null, "asc")}
            />
          ) : null}
          {groupCol ? (
            <QueryChip
              label={`分组 · ${groupCol.label}`}
              onRemove={() => onGroup(null)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ViewTabs({
  views,
  activeId,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
}: {
  views: TableView[];
  activeId: string;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
        {views.map((v) =>
          renamingId === v.id ? (
            <Input
              key={v.id}
              autoFocus
              aria-label="视图名称"
              className="h-7 w-28"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => {
                const next = renameDraft.trim();
                if (next && next !== v.name) onRename(v.id, next);
                setRenamingId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenamingId(null);
              }}
            />
          ) : (
            <div key={v.id} className="flex items-center">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`视图 ${v.name}`}
                aria-pressed={v.id === activeId}
                onClick={() => onSwitch(v.id)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  setRenamingId(v.id);
                  setRenameDraft(v.name);
                }}
                className={cn(
                  "h-7 px-2.5",
                  v.id === activeId
                    ? "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground"
                    : "text-muted-foreground",
                )}
              >
                {v.name}
              </Button>
              {v.id === activeId ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      size="sm"
                      aria-label={`视图 ${v.name} 操作`}
                      className="size-7"
                    >
                      <MoreHorizontal size={14} />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => {
                        setRenamingId(v.id);
                        setRenameDraft(v.name);
                      }}
                    >
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="danger"
                      disabled={views.length <= 1}
                      onSelect={() => {
                        if (views.length > 1) onDelete(v.id);
                      }}
                    >
                      删除视图
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          ),
        )}
      </div>
      <SimpleTooltip label="添加视图">
        <IconButton size="sm" aria-label="添加视图" onClick={onAdd}>
          <Plus size={14} />
        </IconButton>
      </SimpleTooltip>
    </div>
  );
}

function ModeStrip({
  mode,
  modes,
  onChange,
}: {
  mode: DisplayMode;
  modes: DisplayMode[];
  onChange: (mode: DisplayMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="显示模式"
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {modes.map((m) => {
        const Icon = MODE_ICON[m];
        const selected = m === mode;
        return (
          <SimpleTooltip key={m} label={DISPLAY_MODE_LABELS[m]}>
            <IconButton
              size="sm"
              role="tab"
              aria-label={DISPLAY_MODE_LABELS[m]}
              aria-selected={selected}
              onClick={() => onChange(m)}
              className={
                selected
                  ? "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground"
                  : undefined
              }
            >
              <Icon size={14} />
            </IconButton>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}

function SearchToggle({
  value,
  onChange,
}: {
  value: string;
  onChange: (q: string) => void;
}) {
  const [open, setOpen] = useState(Boolean(value));
  const expanded = open || Boolean(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  if (!expanded) {
    return (
      <Button
        variant="neutral"
        size="sm"
        icon={<Search size={14} />}
        onClick={() => setOpen(true)}
      >
        查找
      </Button>
    );
  }
  return (
    <SearchField
      ref={inputRef}
      size="sm"
      placeholder="查找"
      value={value}
      onValueChange={onChange}
      aria-label="查找表格"
      className="w-40 shrink-0"
      onBlur={() => {
        if (!value) setOpen(false);
      }}
    />
  );
}

function QueryChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-muted px-1.5 py-0.5 text-xs text-foreground">
      {label}
      <IconButton
        size="sm"
        aria-label={`移除 ${label}`}
        className="size-5"
        onClick={onRemove}
      >
        <X size={12} />
      </IconButton>
    </span>
  );
}
