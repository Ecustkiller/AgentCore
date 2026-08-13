import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Tone = "neutral" | "primary" | "success" | "warning" | "destructive";

/**
 * Opaque tints, not `bg-X/10`: a badge is dropped into cards, muted rows and
 * selected turns alike, and an alpha tint takes the surface underneath with it —
 * the same success pill measured 4.0:1 on a card and 3.5:1 inside a selected turn.
 * Each pair is now a fixed ~5:1 wherever the badge lands.
 */
const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary-tint text-primary",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  destructive: "bg-destructive-tint text-destructive",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
