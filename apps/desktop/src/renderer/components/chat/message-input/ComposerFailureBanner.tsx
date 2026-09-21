import { Button, IconButton } from "@/components/ui";
import {
  noticeChipNeutral,
  statusAccentText,
  statusChip,
} from "@/components/ui/tone-presets";
import type { ErrorAction } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { isReconnectQuietBanner } from "@/services/turns/helpers";
import { AlertTriangle, Info, KeyRound, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * The one failure slot above the composer card.
 * Send failure, the last turn's failure sentence, and session copy share it.
 * The parent picks which source is showing.
 */
export function ComposerFailureBanner({
  message,
  action,
  onDismiss,
}: {
  message: string;
  action: ErrorAction | null;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const needsYou = Boolean(action);
  const quiet = !needsYou && isReconnectQuietBanner(message);
  const Icon = quiet ? Info : AlertTriangle;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="composer-failure-banner"
      data-banner-tone={needsYou ? "primary" : quiet ? "notice" : "alert"}
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        needsYou ? statusChip.primary : noticeChipNeutral,
      )}
    >
      <Icon
        size={15}
        className={cn(
          "shrink-0",
          needsYou ? statusAccentText.primary : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{message}</span>
      {action && (
        <Button
          variant="primary"
          className="shrink-0"
          icon={<KeyRound size={13} />}
          onClick={() => {
            onDismiss();
            navigate(action.href);
          }}
        >
          {action.label}
        </Button>
      )}
      <IconButton
        onClick={onDismiss}
        aria-label="关闭"
        className={
          needsYou
            ? "text-primary/70 hover:bg-transparent hover:text-primary"
            : "text-muted-foreground hover:bg-transparent hover:text-foreground"
        }
      >
        <X size={14} />
      </IconButton>
    </div>
  );
}
