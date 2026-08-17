import { SupportDiagnosticCopyButton } from "@/components/SupportDiagnosticCopyButton";
import {
  type SupportDiagnosticIds,
  formatSupportDiagnosticText,
} from "@/lib/supportDiagnostics";
import type { TurnOutcome } from "@/lib/turnOutcome";
import { useNavigate } from "react-router-dom";

/** User-facing tone: config remedy (去配置) → needs-you / accent; else recoverable gray. */
function errorSurfaceClass(
  kind: "bar" | "inline-actions",
  needsYou: boolean,
): string {
  return needsYou ? `error ${kind} needs-you` : `error ${kind}`;
}

/**
 * One verdict sentence + one recovery action + 排查包.
 * Host (bubble banner vs team strip) is chosen by the arbiter `surface`.
 * `surface=composer` is ChatPage's input hint — this card must not mount there.
 */
export function TurnOutcomeActions({
  outcome,
  supportIds,
  onRetry,
  hideNotice = false,
}: {
  outcome: TurnOutcome;
  supportIds: SupportDiagnosticIds;
  onRetry?: () => void;
  /** Strip already paints the same short title — don't repeat it as the sentence. */
  hideNotice?: boolean;
}) {
  const navigate = useNavigate();
  const recovery = outcome.recovery;
  const notice = hideNotice ? null : outcome.notice;
  const needsYou = recovery.kind === "configure";
  const showRetry = recovery.kind === "retry" && !!onRetry;
  const showConfigure = recovery.kind === "configure";
  const hasDiag = !!formatSupportDiagnosticText(supportIds);
  if (!notice && !showRetry && !showConfigure && !hasDiag) return null;
  return (
    <div
      className={errorSurfaceClass("inline-actions", needsYou)}
      data-testid="turn-outcome"
      data-kind={outcome.kind}
      data-surface={outcome.surface}
    >
      {notice ? <span>{notice}</span> : null}
      <div className="error-card-actions">
        <SupportDiagnosticCopyButton ids={supportIds} />
        {showConfigure && (
          <button
            type="button"
            className="retry-btn"
            onClick={() => navigate(recovery.href)}
          >
            {recovery.label}
          </button>
        )}
        {showRetry && (
          <button type="button" className="retry-btn" onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    </div>
  );
}
