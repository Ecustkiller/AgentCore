import { formatCell } from "./fieldMeta";
import { visibleColumns } from "./query";
import type { TableDoc } from "./types";

export function tableToCsv(table: TableDoc): string {
  const view = table.views.find((v) => v.id === table.activeViewId);
  const cols = visibleColumns(
    table.columns,
    view?.config.hiddenColumnIds ?? [],
  );
  const header = cols.map((c) => escapeCsv(c.label)).join(",");
  const lines = table.rows
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((row) =>
      cols
        .map((c) => escapeCsv(formatCell(c, row.cells[c.id] ?? null)))
        .join(","),
    );
  return `\uFEFF${[header, ...lines].join("\n")}`;
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function downloadCsv(table: TableDoc): void {
  const blob = new Blob([tableToCsv(table)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${table.title || "表格"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
