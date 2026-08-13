import { cardVariantClass } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * - `static` — a label/description line with a control or a read-only value on
 *   the right (开关行、只读值行). Renders a `<div>`.
 * - `select` — one option of a single-choice group; `selected` tints the row and
 *   adds a trailing check. Renders a `<button aria-pressed>`.
 * - `nav` — opens something else (a dialog, another page); trailing chevron.
 */
export type SettingRowVariant = "static" | "select" | "nav";

/**
 * - `card` — a standalone surface (its own border + radius).
 * - `list` — one row among siblings inside a shared `Card`; pair with `divider`.
 * - `bare` — no chrome at all; the caller owns padding (e.g. an `<li>`).
 */
export type SettingRowSurface = "card" | "list" | "bare";

const surfaceClass: Record<SettingRowSurface, string> = {
  card: "rounded-xl border px-4 py-3",
  list: "px-4 py-2.5",
  bare: "",
};

const alignClass: Record<"center" | "start", string> = {
  center: "items-center",
  start: "items-start",
};

export interface SettingRowProps {
  label: ReactNode;
  /** Second line under the label — what the setting does / what it costs. */
  description?: ReactNode;
  /** Leading slot: an icon badge or avatar. */
  leading?: ReactNode;
  /** Right-hand control: `Switch`, `Button`, `Badge`, a key-cap chip… */
  control?: ReactNode;
  /** Right-hand read-only value. Mutes the label, since the value is the point
   *  of the row (版本信息、用量明细). Wrap it yourself for `font-mono`. */
  value?: ReactNode;
  variant?: SettingRowVariant;
  surface?: SettingRowSurface;
  /** `select` rows only — current choice. */
  selected?: boolean;
  disabled?: boolean;
  /** Required by `select` / `nav`; ignored by `static`. */
  onClick?: () => void;
  /** Hairline above the row — stacked `list` rows inside one `Card`. */
  divider?: boolean;
  align?: "center" | "start";
  className?: string;
}

/**
 * One row of a settings list: label (+ description) on the left, a control or a
 * value on the right.
 *
 * Covers the four shapes the subpages had each re-implemented — toggle row,
 * single-choice row, navigation row, read-only value row — so they no longer
 * differ in padding, radius, hover tint or check placement. Clickable card rows
 * reuse `Card`'s `interactive` variant rather than restating its hover chrome.
 */
export function SettingRow({
  label,
  description,
  leading,
  control,
  value,
  variant = "static",
  surface = "card",
  selected = false,
  disabled = false,
  onClick,
  divider = false,
  align = "center",
  className,
}: SettingRowProps) {
  const clickable = variant !== "static";
  const muteLabel = value !== undefined;

  const classes = cn(
    "flex w-full gap-3 text-left",
    alignClass[align],
    surfaceClass[surface],
    divider && "border-t border-border",
    surface === "card" &&
      (clickable && !selected
        ? cardVariantClass.interactive
        : cardVariantClass.default),
    surface !== "card" && clickable && "transition-colors hover:bg-accent/40",
    selected && "border-primary/40 bg-primary/5",
    clickable && "cursor-pointer disabled:pointer-events-none",
    disabled && "opacity-60",
    className,
  );

  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm",
            muteLabel ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {label}
        </span>
        {description && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {value !== undefined && (
        <span className="shrink-0 text-sm tabular-nums text-foreground">
          {value}
        </span>
      )}
      {control}
      {variant === "select" && selected && (
        <Check size={16} className="shrink-0 text-primary" aria-hidden />
      )}
      {variant === "nav" && (
        <ChevronRight
          size={16}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}
    </>
  );

  if (!clickable) {
    return <div className={classes}>{body}</div>;
  }

  return (
    <button
      type="button"
      aria-pressed={variant === "select" ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
      className={classes}
    >
      {body}
    </button>
  );
}
