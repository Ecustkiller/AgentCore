interface ServiceUnavailablePageProps {
  reason: string;
  onRetry: () => void;
}

/**
 * Shown when the backend can't be reached on startup (e.g. the database is
 * down), in place of a login form that would just fail. Mirrors LoginPage's
 * centered, minimal layout so the boot experience stays consistent.
 */
export function ServiceUnavailablePage({
  reason,
  onRetry,
}: ServiceUnavailablePageProps) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-xl font-semibold text-foreground">AgentCore</h1>
        <p className="mt-2 text-sm text-muted-foreground">服务暂时不可用</p>
        <p className="mt-4 text-sm text-destructive">{reason}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 h-10 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          重试
        </button>
      </div>
    </div>
  );
}
