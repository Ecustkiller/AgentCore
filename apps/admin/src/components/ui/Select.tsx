import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Native `<select>` in the console's clothing.
 *
 * Native on purpose — it gets keyboard behaviour, mobile pickers and screen-reader
 * support for free, which a hand-built listbox would have to re-earn. The wrapper
 * only supplies the chevron and the shared field styling that six pages were
 * re-typing as a 200-character class string.
 *
 * `aria-label` is required rather than optional: every filter dropdown in this
 * console is unlabelled visually, so without it the control is anonymous.
 */
export function Select({
  options,
  className,
  "aria-label": ariaLabel,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  options: SelectOption[];
  "aria-label": string;
}) {
  return (
    <div className="relative inline-flex">
      <select
        aria-label={ariaLabel}
        className={cn(
          "h-9 appearance-none rounded-lg border border-input bg-card pr-8 pl-3 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value || "__all__"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
