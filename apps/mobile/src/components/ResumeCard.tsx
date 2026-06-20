import type { PausedTurnSummary } from "@/api/turn";
// Durable resume card — the actionable surface for a turn that paused at a checkpoint then
// lost its live stream (结构化挂起 2b). Unlike PauseCard (which settles a LIVE fold
// `pendingInteraction` over the still-open SSE via resolveInteraction), this reads a
// PERSISTED PausedTurnSummary (no assistant message yet, only a frame) and asks the parent
// to drive a fresh resume stream (api/stream.ts::resumeStream). Surfaced on reopen so a
// turn whose stream dropped while paused stays recoverable.
//
// Mobile's own UI (cross-platform-frontend.mdc: zero shared business components). The
// decision vocabulary mirrors the live checkpoint: 继续 (continue — note carries the
// ask_user answer / no-op steer), 调整 (plan_review only — note steers the downstream),
// 停止 (end the turn here).
import type { CheckpointDecision } from "@agentcore/contract-types";
import { useState } from "react";

/** Read a string field defensively off a steps/pending dict (backend dict[str, Any]). */
function str(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === "string" && v.trim() ? v : null;
}

export function ResumeCard({
  paused,
  onResume,
}: {
  paused: PausedTurnSummary;
  // Acting on the card starts a resume stream; the parent then drops the card and shows the
  // streaming bubble (so there is no in-card busy state — it unmounts on submit).
  onResume: (decision: CheckpointDecision, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const isPlanReview = paused.kind === "plan_review";

  return (
    <div className="pause">
      <div className="pause-title">
        {isPlanReview
          ? "执行已暂停 · 待你决定是否继续"
          : "需要你拍板（已离线保留）"}
      </div>
      {paused.user_message && (
        <div className="pause-context">{paused.user_message}</div>
      )}
      {!isPlanReview && paused.question && (
        <div className="pause-question">{paused.question}</div>
      )}
      {!isPlanReview && paused.context && (
        <div className="pause-context">{paused.context}</div>
      )}
      {isPlanReview && paused.steps.length > 0 && (
        <div className="pause-steps">
          {paused.steps.map((s, i) => {
            const role = str(s, "role") ?? str(s, "task");
            const summary = str(s, "output_summary");
            return (
              // Steps are a stable persisted list; index keys are fine.
              // biome-ignore lint/suspicious/noArrayIndexKey: persisted, stable order
              <div key={i} className="pause-step">
                {role && <div className="pause-step-role">{role}</div>}
                {summary && <div className="pause-step-summary">{summary}</div>}
              </div>
            );
          })}
        </div>
      )}
      <textarea
        className="pause-note"
        rows={2}
        value={note}
        placeholder={
          isPlanReview
            ? "可选 · 调整时作为对下游的指示；停止时作为收尾备注"
            : "可选 · 你的答复或补充，留空则按上面继续"
        }
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="pause-actions">
        <button
          type="button"
          className="pause-btn pause-btn-primary"
          onClick={() => onResume("continue", note.trim())}
        >
          继续
        </button>
        {isPlanReview && (
          <button
            type="button"
            className="pause-btn pause-btn-neutral"
            disabled={!note.trim()}
            onClick={() => onResume("adjust", note.trim())}
          >
            调整
          </button>
        )}
        <button
          type="button"
          className="pause-btn pause-btn-danger"
          onClick={() => onResume("stop", note.trim())}
        >
          停止
        </button>
      </div>
    </div>
  );
}
