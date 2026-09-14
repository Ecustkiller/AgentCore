import { Input, Select } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { KeyboardEvent } from "react";
import { OPTION_TONE_CLASS, formatCell, optionLabel } from "./fieldMeta";
import type { CellValue, ColumnDef, OptionTone } from "./types";

export function OptionChip({
  label,
  tone = "gray",
}: {
  label: string;
  tone?: OptionTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full truncate rounded-lg px-1.5 py-0.5 text-xs",
        OPTION_TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

export function CellDisplay({
  column,
  value,
}: {
  column: ColumnDef;
  value: CellValue;
}) {
  if (column.type === "checkbox") {
    return (
      <span className={value ? "text-foreground" : "text-muted-foreground"}>
        {value ? "✓" : ""}
      </span>
    );
  }
  if (column.type === "singleSelect" && typeof value === "string" && value) {
    const opt = column.options?.find((o) => o.id === value);
    return opt ? <OptionChip label={opt.label} tone={opt.tone} /> : null;
  }
  if (
    column.type === "multiSelect" &&
    Array.isArray(value) &&
    value.length > 0
  ) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((id) => {
          const opt = column.options?.find((o) => o.id === id);
          return opt ? (
            <OptionChip key={id} label={opt.label} tone={opt.tone} />
          ) : null;
        })}
      </span>
    );
  }
  if (column.type === "url" && typeof value === "string" && value) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="truncate text-primary underline-offset-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {value}
      </a>
    );
  }
  const text = formatCell(column, value);
  return <span className="truncate">{text}</span>;
}

export function CellEditor({
  column,
  value,
  onChange,
  onCommit,
  onCancel,
  onMove,
}: {
  column: ColumnDef;
  value: CellValue;
  onChange: (value: CellValue) => void;
  onCommit: (value?: CellValue) => void;
  onCancel: () => void;
  onMove?: (dir: "left" | "right") => void;
}) {
  const stop = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      onCommit();
      onMove?.(e.shiftKey ? "left" : "right");
    }
    e.stopPropagation();
  };

  if (column.type === "checkbox") {
    return (
      <input
        type="checkbox"
        aria-label={column.label}
        className="size-3.5 accent-[var(--primary)]"
        checked={Boolean(value)}
        onChange={(e) => onCommit(e.target.checked)}
      />
    );
  }

  if (column.type === "singleSelect") {
    return (
      <Select
        autoFocus
        aria-label={column.label}
        className="h-7"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onCommit(e.target.value || null)}
        onKeyDown={stop}
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
    const selected = new Set(Array.isArray(value) ? value : []);
    return (
      <div
        className="flex flex-col gap-1 py-1"
        onKeyDown={stop}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            onCommit();
          }
        }}
      >
        {(column.options ?? []).map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--primary)]"
              checked={selected.has(o.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(o.id);
                else next.delete(o.id);
                onChange([...next]);
              }}
            />
            {optionLabel(column, o.id)}
          </label>
        ))}
      </div>
    );
  }

  if (column.type === "number") {
    return (
      <Input
        autoFocus
        type="number"
        aria-label={column.label}
        className="h-7"
        value={typeof value === "number" ? value : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        onBlur={() => onCommit()}
        onKeyDown={stop}
      />
    );
  }

  if (column.type === "date" || column.type === "datetime") {
    return (
      <Input
        autoFocus
        type={column.type === "date" ? "date" : "datetime-local"}
        aria-label={column.label}
        className="h-7"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={() => onCommit()}
        onKeyDown={stop}
      />
    );
  }

  return (
    <Input
      autoFocus
      type={column.type === "url" ? "url" : "text"}
      aria-label={column.label}
      className="h-7"
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onCommit()}
      onKeyDown={stop}
    />
  );
}
