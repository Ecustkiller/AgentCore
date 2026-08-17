import { Button } from "@/components/ui";
import { noticeChipNeutral } from "@/components/ui/tone-presets";
import {
  PAUSED_CONTINUE_LABEL,
  PAUSED_STATUS_LABEL,
  attestedWaitHint,
} from "@/lib/turnOutcome";
import { cn } from "@/lib/utils";
import { Pause } from "lucide-react";
import { useEffect, useState } from "react";

function remainingFrom(retryAfterSec: number | null | undefined): number {
  if (retryAfterSec == null || retryAfterSec <= 0) return 0;
  return Math.ceil(retryAfterSec);
}

export function PausedContinueSurface({
  reason,
  onContinue,
  compact,
  retryAfterSec,
}: {
  reason: string | null;
  onContinue: () => void;
  compact?: boolean;
  /** Attested Retry-After seconds; omit when the cooldown is unattested. */
  retryAfterSec?: number | null;
}) {
  const [remaining, setRemaining] = useState(() =>
    remainingFrom(retryAfterSec),
  );
  useEffect(() => {
    const start = remainingFrom(retryAfterSec);
    if (start <= 0) {
      setRemaining(0);
      return;
    }
    const end = Date.now() + start * 1000;
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [retryAfterSec]);

  const waiting = remaining > 0;
  const waitCopy = waiting ? attestedWaitHint(remaining) : null;

  return (
    <div
      className={cn(
        compact
          ? "flex min-w-0 flex-1 items-center gap-2"
          : cn(
              "mt-2 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
              noticeChipNeutral,
            ),
      )}
      data-testid="paused-continue-surface"
    >
      {!compact && (
        <Pause size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{PAUSED_STATUS_LABEL}</p>
        {reason ? (
          <p
            className={
              compact
                ? "truncate text-xs text-muted-foreground"
                : "mt-0.5 whitespace-pre-wrap break-words text-muted-foreground"
            }
          >
            {reason}
          </p>
        ) : null}
        {waitCopy ? (
          <p
            className={
              compact
                ? "truncate text-xs text-muted-foreground"
                : "mt-0.5 text-muted-foreground"
            }
            data-testid="paused-continue-wait"
          >
            {waitCopy}
          </p>
        ) : null}
      </div>
      <Button
        variant="primary"
        className="shrink-0"
        onClick={onContinue}
        disabled={waiting}
        title={waitCopy ?? undefined}
        data-testid="paused-continue-action"
      >
        {PAUSED_CONTINUE_LABEL}
      </Button>
    </div>
  );
}
