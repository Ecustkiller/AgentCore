import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CellDisplay } from "./cells";
import { formatCell } from "./fieldMeta";
import type { ColumnDef, TableRow } from "./types";

export function GalleryBoard({
  columns,
  rows,
  titleFieldId,
  subtitleFieldIds,
  selectedIds,
  onToggleRow,
}: {
  columns: ColumnDef[];
  rows: TableRow[];
  titleFieldId: string;
  subtitleFieldIds?: string[];
  selectedIds: Set<string>;
  onToggleRow: (id: string) => void;
}) {
  const title = columns.find((c) => c.id === titleFieldId);
  const extras = (subtitleFieldIds ?? [])
    .map((id) => columns.find((c) => c.id === id))
    .filter((c): c is ColumnDef => Boolean(c));
  const rest = columns.filter(
    (c) => c.id !== titleFieldId && !extras.some((e) => e.id === c.id),
  );

  return (
    <div className="absolute inset-0 overflow-auto p-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {rows.map((row) => {
          const selected = selectedIds.has(row.id);
          return (
            <Card
              key={row.id}
              // biome-ignore lint/a11y/useSemanticElements: gallery card hosts nested chips; native button cannot wrap them
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              variant="interactive"
              className={cn(
                "flex cursor-pointer flex-col gap-2 p-4 text-left",
                selected && "ring-1 ring-ring",
              )}
              onClick={() => onToggleRow(row.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggleRow(row.id);
                }
              }}
            >
              <h3 className="truncate text-sm font-medium">
                {title
                  ? formatCell(title, row.cells[title.id] ?? null) || "未命名"
                  : row.id}
              </h3>
              {extras.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {extras.map((c) => (
                    <CellDisplay
                      key={c.id}
                      column={c}
                      value={row.cells[c.id] ?? null}
                    />
                  ))}
                </div>
              ) : null}
              {rest.slice(0, 2).map((c) => (
                <p
                  key={c.id}
                  className="truncate text-xs text-muted-foreground"
                >
                  {c.label} · {formatCell(c, row.cells[c.id] ?? null) || "—"}
                </p>
              ))}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
