import {
  HANGING_QUESTION_CAPTION,
  HANGING_QUESTION_CTA,
  HANGING_QUESTION_DETACHED_HINT,
  formatHangingDefault,
} from "@/lib/hangingQuestion";
import type { NonBlockingAsk } from "@/protocol/fold";
import { MessageCircle } from "lucide-react";
import { useState } from "react";

/**
 * Bottom-bar face for pending non-blocking questions.
 * Distinct from ResumeCard (「需要你拍板」/ 团队停工). Do not reuse .ask / .pause chrome.
 */
export function HangingQuestionBar({
  asks,
  detached = false,
  readOnly = false,
  onReply,
}: {
  asks: NonBlockingAsk[];
  detached?: boolean;
  readOnly?: boolean;
  onReply?: (askId: string, text: string) => Promise<void>;
}) {
  if (asks.length === 0) return null;

  return (
    <div className="hanging-question-bar" data-testid="hanging-question-bar">
      {asks.map((ask) => (
        <HangingQuestionCard
          key={ask.id}
          ask={ask}
          detached={detached}
          readOnly={readOnly}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

function HangingQuestionCard({
  ask,
  detached,
  readOnly,
  onReply,
}: {
  ask: NonBlockingAsk;
  detached: boolean;
  readOnly: boolean;
  onReply?: (askId: string, text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultHint = formatHangingDefault(ask.assumptions);
  const canSend = draft.trim().length > 0 && !busy && !readOnly && !!onReply;

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy || !onReply) return;
    setBusy(true);
    setError(null);
    try {
      await onReply(ask.id, text);
      setDraft("");
    } catch {
      setError("答复失败");
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div
      className="hanging-question-card"
      data-testid="hanging-question-card"
      data-ask-id={ask.id}
      data-hanging-urgency="running"
    >
      <div className="hanging-question-head">
        <MessageCircle size={14} aria-hidden />
        <span data-testid="hanging-question-caption">
          {HANGING_QUESTION_CAPTION}
        </span>
      </div>
      <p className="hanging-question-q">{ask.question}</p>
      {ask.context ? (
        <p className="hanging-question-context">{ask.context}</p>
      ) : null}
      {defaultHint ? (
        <p className="hanging-question-default">{defaultHint}</p>
      ) : null}
      {detached ? (
        <p
          className="hanging-question-detached"
          data-testid="hanging-question-detached-hint"
        >
          {HANGING_QUESTION_DETACHED_HINT}
        </p>
      ) : null}
      <textarea
        className="hanging-question-input"
        placeholder="写给团队的答复"
        value={draft}
        disabled={busy || readOnly}
        onChange={(e) => setDraft(e.target.value)}
        data-testid="hanging-question-input"
      />
      {error ? <p className="hanging-question-error">{error}</p> : null}
      <div className="hanging-question-actions">
        <button
          type="button"
          className="hanging-question-submit"
          disabled={!canSend}
          onClick={() => void submit()}
          data-testid="hanging-question-submit"
        >
          {HANGING_QUESTION_CTA}
        </button>
      </div>
    </div>
  );
}
