/**
 * CEO rate-limit pause face — one verdict + one action (已暂停 / 继续).
 *
 * Distinct from ResumeCard (checkpoint continue) and PauseCard (live approval).
 * Gate pauses (`finish=paused`, `outcome=null`) must not render this.
 *
 * `onContinue` must reject on failure (HTTP or transport drop) so this face
 * unlocks for retry. A resolve is success and stays busy until unmount.
 */
import { PAUSED_VERDICT } from "@/lib/turnOutcome";
import { useState } from "react";

export function PausedContinueCard({
  reason,
  onContinue,
  locked = false,
}: {
  reason?: string | null;
  onContinue?: () => Promise<void> | void;
  locked?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const disabled = locked || busy || !onContinue;
  const explanation = reason?.trim() || null;

  async function handleContinue() {
    if (disabled || !onContinue) return;
    setBusy(true);
    setErr(null);
    try {
      await onContinue();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "继续失败");
      setBusy(false);
    }
  }

  return (
    <div
      className="error inline-actions"
      data-testid="paused-continue"
      data-kind="paused"
    >
      <div className="paused-continue-head">
        <span className="paused-continue-verdict">{PAUSED_VERDICT}</span>
        {onContinue ? (
          <button
            type="button"
            className="retry-btn"
            disabled={disabled}
            onClick={() => void handleContinue()}
          >
            {busy ? "继续中…" : "继续"}
          </button>
        ) : null}
      </div>
      {explanation ? (
        <p className="paused-continue-reason">{explanation}</p>
      ) : null}
      {err ? <div className="error pause-err">{err}</div> : null}
    </div>
  );
}
