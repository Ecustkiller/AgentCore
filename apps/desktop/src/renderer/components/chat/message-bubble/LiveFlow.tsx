import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** Reduced-motion fallback for in-flight process chrome (`LiveFlow`). */
export function ThinkingDots({ className }: { className?: string } = {}) {
  return (
    <span className={cn("inline-flex gap-1", className)} aria-hidden>
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}

/**
 * In-flight process surface marker. Title glyphs sheen via {@link LiveFlowText};
 * do not overlay the row. Reduced-motion stops the sheen (CSS) and callers show
 * {@link LiveFlowDots}. Not for streaming markdown or chrome spinners.
 */
export function LiveFlow({
  active,
  className,
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("min-w-0", className)}
      {...(active ? { "data-live-flow": "" } : {})}
    >
      {children}
    </div>
  );
}

/** Title that sheens while an ancestor {@link LiveFlow} is active. */
export function LiveFlowText({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn("live-flow-text", className)}>{children}</span>;
}

/** Reduced-motion fallback for {@link LiveFlow}. Hidden unless `prefers-reduced-motion`. */
export function LiveFlowDots({ active }: { active: boolean }) {
  if (!active) return null;
  return <ThinkingDots className="hidden motion-reduce:inline-flex" />;
}

/** Empty thinking / workspace-wait row — always the live surface while mounted.
 * 思考/正文一旦在长则不要走这里。过程行不出秒表。 */
export function LiveWaitLabel({ children }: { children: ReactNode }) {
  return (
    <LiveFlow
      active
      className="inline-flex items-center gap-2 text-sm text-muted-foreground"
    >
      <LiveFlowDots active />
      <LiveFlowText>{children}</LiveFlowText>
    </LiveFlow>
  );
}
