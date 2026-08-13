import { cn } from "@/lib/utils";
import type { KeyboardEvent, ReactNode, ThHTMLAttributes } from "react";

type Align = "left" | "right" | "center";

const ALIGN: Record<Align, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

/**
 * Bordered, horizontally scrollable table frame.
 *
 * `minWidth` is required rather than optional: a table that can't fit its columns
 * must scroll, not silently clip. Most console tables used `overflow-hidden`, which
 * hid the right-hand columns at narrow widths with no way to reach them.
 */
export function TableFrame({
  children,
  minWidth,
  className,
}: {
  children: ReactNode;
  minWidth: number;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto rounded-xl border border-border bg-card", className)}>
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-muted/40 text-muted-foreground text-xs">
      <tr className="border-border border-b">{children}</tr>
    </thead>
  );
}

export function Th({
  children,
  align = "left",
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: Align }) {
  return (
    <th
      scope="col"
      className={cn("px-4 py-2.5 font-medium", ALIGN[align], className)}
      {...props}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: Align }) {
  return (
    <td className={cn("px-4 py-3", ALIGN[align], className)} {...props}>
      {children}
    </td>
  );
}

/**
 * A table row that can be activated as a whole.
 *
 * Rows keep their native `row` semantics (no `role="link"`, which would break the
 * table for screen readers) but become focusable and respond to Enter/Space, so
 * "点行进复盘" — the console's main drill-in path — is reachable without a mouse.
 * `label` names the destination for assistive tech, since the visible cells alone
 * don't say what activating the row does.
 */
export function TableRow({
  children,
  onActivate,
  label,
  className,
}: {
  children: ReactNode;
  onActivate?: () => void;
  label?: string;
  className?: string;
}) {
  const base = "border-border border-b last:border-b-0";
  if (!onActivate) {
    return <tr className={cn(base, className)}>{children}</tr>;
  }
  const handleKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Ignore keys aimed at a control inside the row (a copy button, a link).
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    onActivate();
  };
  return (
    <tr
      tabIndex={0}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={handleKeyDown}
      className={cn(
        base,
        "cursor-pointer outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
    >
      {children}
    </tr>
  );
}

/** Full-width message row (empty / error) that keeps the table's column count. */
export function TableMessageRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}
