import { SimpleTooltip } from "@/components/ui/tooltip";
import { Loader2 } from "lucide-react";

/**
 * Shared presentational primitives for the file UIs (文件中枢统一) — the tree /
 * preview / snapshot surfaces of both the Files page and the conversation
 * workspace panel. Kept intentionally file-scoped (not generic app UI).
 */

export function IconButton({
  title,
  onClick,
  spinning,
  children,
}: {
  title: string;
  onClick: () => void;
  spinning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SimpleTooltip label={title}>
      <button
        type="button"
        onClick={onClick}
        disabled={spinning}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
      >
        {spinning ? <Loader2 size={14} className="animate-spin" /> : children}
      </button>
    </SimpleTooltip>
  );
}

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">{children}</div>
  );
}

export function InlineError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-xs text-muted-foreground">加载失败</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
      >
        重试
      </button>
    </div>
  );
}

export function EmptyHint({
  icon,
  title,
  hint,
  inline,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  inline?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 px-6 text-center ${
        inline ? "h-full" : "flex-1"
      }`}
    >
      {icon}
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
