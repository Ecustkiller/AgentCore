import { cn } from "@/lib/utils";
import { type SelectHTMLAttributes, forwardRef } from "react";
import { fieldSurfaceClass } from "./input";

/**
 * Native `<select>` with the shared field chrome — the same surface and height
 * as {@link Input}, so a dropdown never drifts from the text inputs beside it.
 *
 * Full-width by default: every call site wants the field to fill its column, and
 * forgetting `w-full` is the exact slip that renders a stray narrow control.
 * Pass `className="w-auto"` for the rare inline case. Options stay as children
 * (`<option>` / `<optgroup>`), including the leading disabled placeholder that
 * required slots use.
 */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(fieldSurfaceClass, "h-8 w-full px-2.5", className)}
      {...props}
    />
  );
});
