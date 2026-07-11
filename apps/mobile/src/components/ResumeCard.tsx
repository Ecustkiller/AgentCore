import type { PausedTurnSummary } from "@/api/turn";
// Durable resume card — the actionable surface for a turn that paused at a checkpoint then
// lost its live stream (结构化挂起 2b). Unlike PauseCard (which settles a LIVE fold
// `interactions[]` over the still-open SSE via resolveInteraction), this reads a
// PERSISTED PausedTurnSummary (no assistant message yet, only a frame) and asks the parent
// to drive a fresh resume stream (api/stream.ts::resumeStream).
//
// Mobile's own UI (cross-platform-frontend.mdc). ask_user 阻塞问答内核（choice/text/default
// chips）对齐 NonBlockingAskCard / 桌面 AskUserFields（P3 D4）.
import type { AskOption, CheckpointDecision } from "@agentcore/contract-types";
import { useState } from "react";

function str(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === "string" && v.trim() ? v : null;
}

function asRecords(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v)
    ? v.filter(
        (x): x is Record<string, unknown> =>
          !!x && typeof x === "object" && !Array.isArray(x),
      )
    : [];
}

export function ResumeCard({
  paused,
  onResume,
}: {
  paused: PausedTurnSummary;
  onResume: (decision: CheckpointDecision, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const isPlanReview = paused.kind === "plan_review";
  const isTeamPreview = paused.kind === "team_preview";
  const isAskUser =
    paused.kind === "ask_user" || (!isPlanReview && !isTeamPreview);
  const showWorkers = isPlanReview || isTeamPreview;
  const questions = asRecords(paused.questions);
  const assumptions = asRecords(paused.assumptions);
  const styleOptions = asRecords(paused.style_options);

  const pickChip = (prompt: string, value: string) => {
    const multi = questions.length > 1;
    const text = multi && prompt ? `${prompt}：${value}` : value;
    setNote((prev) => (prev.trim() ? `${prev}\n${text}` : text));
  };

  return (
    <div className="pause">
      <div className="pause-title">
        {isTeamPreview
          ? "团队预审 · 开干前确认"
          : isPlanReview
            ? "执行已暂停 · 待你决定是否继续"
            : "需要你拍板（已离线保留）"}
      </div>
      {paused.user_message && (
        <div className="pause-context">{paused.user_message}</div>
      )}
      {!showWorkers && paused.question && (
        <div className="pause-question">{paused.question}</div>
      )}
      {!showWorkers && paused.context && (
        <div className="pause-context">{paused.context}</div>
      )}
      {isAskUser && assumptions.length > 0 && (
        <div className="ask-assume">
          <div className="ask-assume-label">我先按这些默认推进</div>
          {assumptions.map((a) => (
            <div
              key={str(a, "id") ?? str(a, "label") ?? ""}
              className="ask-assume-row"
            >
              <span className="ask-assume-k">{str(a, "label")}</span>
              <span className="ask-assume-v">{str(a, "value")}</span>
            </div>
          ))}
        </div>
      )}
      {isAskUser &&
        questions.map((q) => {
          const id = str(q, "id") ?? str(q, "prompt") ?? "";
          const prompt = str(q, "prompt") ?? "";
          const kind = str(q, "kind");
          const def = str(q, "default");
          const options = asRecords(q.options);
          const chips: AskOption[] =
            kind === "text"
              ? def
                ? [{ label: def }]
                : []
              : options
                  .map((o) => ({
                    label: str(o, "label") ?? "",
                    detail: str(o, "detail") ?? undefined,
                    recommended: Boolean(o.recommended),
                  }))
                  .filter((o) => o.label);
          return (
            <div key={id} className="ask-question">
              {prompt && <div className="ask-prompt">{prompt}</div>}
              {chips.length > 0 && (
                <div className="ask-chips">
                  {chips.map((opt) => {
                    const isDefault = !!def && opt.label === def;
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        className="ask-chip"
                        onClick={() => pickChip(prompt, opt.label)}
                      >
                        <span>{opt.label}</span>
                        {opt.recommended && (
                          <span className="ask-badge ask-badge-rec">推荐</span>
                        )}
                        {isDefault && <span className="ask-badge">默认</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      {isAskUser && styleOptions.length > 0 && (
        <div className="ask-chips">
          {styleOptions.map((s) => {
            const label = str(s, "label") ?? "";
            const id = str(s, "id") ?? label;
            return (
              <button
                key={id}
                type="button"
                className="ask-chip"
                onClick={() => pickChip("风格", label)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {isPlanReview && (paused.steps?.length ?? 0) > 0 && (
        <div className="pause-steps">
          {(paused.steps ?? []).map((s, i) => {
            const role = str(s, "role") ?? str(s, "task");
            const summary = str(s, "output_summary");
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: persisted, stable order
              <div key={i} className="pause-step">
                {role && <div className="pause-step-role">{role}</div>}
                {summary && <div className="pause-step-summary">{summary}</div>}
              </div>
            );
          })}
        </div>
      )}
      {isTeamPreview && (paused.workers?.length ?? 0) > 0 && (
        <div className="pause-steps">
          {(paused.workers ?? []).map((w, i) => {
            const role = str(w, "role");
            const task = str(w, "task");
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: persisted, stable order
              <div key={i} className="pause-step">
                {role && <div className="pause-step-role">{role}</div>}
                {task && <div className="pause-step-summary">{task}</div>}
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
          isTeamPreview
            ? "可选 · 调整时作为对全体队员的指示；停止时作为收尾备注"
            : isPlanReview
              ? "可选 · 调整时作为对下游的指示；停止时作为收尾备注"
              : "可选 · 你的答复或补充，留空则按上面继续"
        }
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="pause-hint">等你拍板 · 不限时</div>
      <div className="pause-actions">
        <button
          type="button"
          className="pause-btn pause-btn-primary"
          onClick={() => onResume("continue", note.trim())}
        >
          {isTeamPreview ? "开做" : "继续"}
        </button>
        {showWorkers && (
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
