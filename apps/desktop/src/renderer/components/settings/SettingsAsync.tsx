import { Button, Card } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/** `inline` = one line in place (default); `card` = a dashed centered panel, for
 *  a first-load state that owns the whole content area. */
export type SettingsAsyncVariant = "inline" | "card";
export type SettingsAsyncSize = "sm" | "md";

const textClass: Record<SettingsAsyncSize, string> = {
  sm: "text-xs",
  md: "text-sm",
};

const spinnerSize: Record<SettingsAsyncSize, number> = {
  sm: 14,
  md: 16,
};

export interface SettingsAsyncProps {
  loading?: boolean;
  /** Non-empty → the error state. Wins over `empty`. */
  error?: ReactNode;
  /** Loaded fine, but there is nothing to show. */
  empty?: boolean;
  loadingLabel?: ReactNode;
  emptyLabel?: ReactNode;
  /** Empty-state CTA that creates the missing thing (添加服务商 / 接入服务商). */
  emptyAction?: ReactNode;
  /** Adds a retry button to the error state. */
  onRetry?: () => void;
  retryLabel?: string;
  variant?: SettingsAsyncVariant;
  size?: SettingsAsyncSize;
  className?: string;
  children?: ReactNode;
}

/**
 * The loading / error / empty shell around a settings block, rendering
 * `children` once there is something to show.
 *
 * The three states used to be spelled out per page, which is how the subpages
 * ended up with six spellings of 「加载中…」 and five of an empty list — some
 * with a spinner, some a bare `<p>`, some silently collapsing an error into an
 * empty list, which reads to the user as "you have nothing" rather than "this
 * failed". Keeping them in one shell also keeps error ≠ empty honest.
 */
export function SettingsAsync({
  loading = false,
  error,
  empty = false,
  loadingLabel = "加载中…",
  emptyLabel = "暂无内容",
  emptyAction,
  onRetry,
  retryLabel = "重试",
  variant = "inline",
  size = "md",
  className,
  children,
}: SettingsAsyncProps) {
  const text = textClass[size];
  const hasState = loading || Boolean(error) || empty;
  if (!hasState) return <>{children}</>;

  const content = loading ? (
    <div
      className={cn(
        "flex items-center gap-2 text-muted-foreground",
        text,
        variant === "card" && "justify-center",
      )}
    >
      <Loader2 size={spinnerSize[size]} className="animate-spin" />
      {loadingLabel}
    </div>
  ) : error ? (
    <>
      <p className={cn("text-muted-foreground", text)}>{error}</p>
      {onRetry && (
        <Button variant="neutral" size="md" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </>
  ) : (
    <>
      <p className={cn("text-muted-foreground", text)}>{emptyLabel}</p>
      {emptyAction}
    </>
  );

  if (variant === "card") {
    return (
      <Card
        className={cn(
          "flex flex-col items-center justify-center gap-3 border-dashed py-8 text-center",
          className,
        )}
      >
        {content}
      </Card>
    );
  }

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      {content}
    </div>
  );
}
