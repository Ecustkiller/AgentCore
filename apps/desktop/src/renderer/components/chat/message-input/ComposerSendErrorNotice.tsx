import { Button, IconButton } from "@/components/ui";
import {
  noticeChipNeutral,
  statusAccentText,
  statusChip,
} from "@/components/ui/tone-presets";
import { copyText } from "@/lib/clipboard";
import {
  buildSupportDiagnosticPack,
  formatSupportDiagnosticText,
} from "@/lib/supportDiagnostics";
import { notifySuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { isReconnectQuietBanner } from "@/services/turns/helpers";
import {
  clearComposerSendError,
  useComposerSendError,
} from "@/stores/composerSendError";
import {
  useActiveError,
  useActiveErrorAction,
  useConversationStore,
} from "@/stores/conversation";
import { AlertTriangle, Copy, Info, KeyRound, X } from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Send-failure copy on the composer card (outside the textarea). Prefers the
 * ephemeral {@link useComposerSendError} slot so a first-send teardown back to
 * ``__draft__`` still shows; falls back to the session error that regenerate
 * / stream interrupt still write. Dismiss clears both stores.
 * Tone: config action → primary; quiet reconnect / finished → Info on
 * {@link noticeChipNeutral}; otherwise triangle on the same chrome.
 */
export function ComposerSendErrorNotice({
  draftKey,
  suppressSession = false,
  onCopySupportPack,
}: {
  draftKey: string;
  /**
   * Gate for sessionError from the turn arbitrator (`!showSessionBanner`).
   * composerError (send before a turn exists) still shows — not a turn verdict.
   */
  suppressSession?: boolean;
  /** 「复制排查包」when this notice is the session host. */
  onCopySupportPack?: () => void;
}) {
  const composerError = useComposerSendError(draftKey);
  const sessionError = useActiveError();
  const sessionAction = useActiveErrorAction();
  const navigate = useNavigate();

  const fromComposer = Boolean(composerError?.message);
  const message =
    composerError?.message ?? (suppressSession ? null : sessionError);
  const action = composerError
    ? composerError.action
    : suppressSession
      ? null
      : sessionAction;
  const composerPack = fromComposer ? composerError?.supportPack : undefined;
  const composerPackText = composerPack
    ? formatSupportDiagnosticText(composerPack)
    : "";
  const showComposerPack = Boolean(composerPackText);
  const showSessionPack = Boolean(onCopySupportPack) && !fromComposer;

  const dismiss = useCallback(() => {
    clearComposerSendError(draftKey);
    useConversationStore.getState().clearError();
  }, [draftKey]);

  const copyComposerPack = useCallback(() => {
    if (!composerPack || !composerPackText) return;
    void buildSupportDiagnosticPack(composerPack).then((text) => {
      if (!text) return;
      void copyText(text).then((ok) => {
        if (ok) notifySuccess("已复制排查包");
      });
    });
  }, [composerPack, composerPackText]);

  if (!message) return null;

  const needsYou = Boolean(action);
  const quiet = !needsYou && isReconnectQuietBanner(message);
  const Icon = quiet ? Info : AlertTriangle;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="composer-send-error"
      data-banner-tone={needsYou ? "primary" : quiet ? "notice" : "alert"}
      className={cn(
        "mx-3 mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
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
      <span className="min-w-0 flex-1">{message}</span>
      {(showSessionPack || showComposerPack) && (
        <Button
          variant="ghost"
          className={
            needsYou
              ? "shrink-0 text-primary/70 hover:bg-transparent hover:text-primary"
              : "shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
          }
          icon={<Copy size={13} />}
          onClick={showComposerPack ? copyComposerPack : onCopySupportPack}
        >
          复制排查包
        </Button>
      )}
      {action && (
        <Button
          variant="primary"
          className="shrink-0"
          icon={<KeyRound size={13} />}
          onClick={() => {
            dismiss();
            navigate(action.href);
          }}
        >
          {action.label}
        </Button>
      )}
      <IconButton
        onClick={dismiss}
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
