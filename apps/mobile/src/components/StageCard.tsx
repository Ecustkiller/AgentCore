import { PendingInteractionChrome } from "@/components/InteractionSheet";
import { StreamHttpError } from "@/lib/errors";
import type { ProjectedInteraction } from "@agentcore/protocol-conformance";
/** 手机端阶段推进卡 — pending 走 Latch + Sheet；orphaned/resolved 仍内联短卡。 */
import { useState } from "react";

type StageLeaf = Extract<ProjectedInteraction, { kind: "stage_card" }>;

const FORM_LABEL: Record<string, string> = {
  debate: "正反辩论",
  red_team: "红队审查",
  roundtable: "圆桌讨论",
};

/** Latch 一行摘要：motion 截断 + 「开辩」。 */
function latchSummary(motion: string, max = 36): string {
  const t = motion.trim().replace(/\s+/g, " ");
  const clipped = t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1))}…`;
  return clipped ? `${clipped} · 开辩` : "开辩";
}

export function StageCard({
  card,
  onResolve,
}: {
  card: StageLeaf;
  onResolve: (args: {
    decision: "start_debate" | "research_first";
    note: string;
    motionOverride?: string | null;
  }) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [motionDraft, setMotionDraft] = useState(card.motion);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (card.status === "orphaned") {
    return (
      <div className="stage-card stage-card--orphaned" data-testid="stage-card">
        <div className="stage-card__title">阶段推进卡已失效</div>
        <p className="stage-card__hint">你已继续对话，此开辩入口不再可用。</p>
      </div>
    );
  }
  if (card.status === "resolved") {
    // fold 未投影 decision；与桌面默认 resolved 文案对齐（research_first 细节不进契约）。
    return (
      <div className="stage-card stage-card--resolved" data-testid="stage-card">
        <div className="stage-card__title">已按此开辩</div>
      </div>
    );
  }

  async function submit(
    decision: "start_debate" | "research_first",
    motionOverride?: string | null,
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve({
        decision,
        note,
        motionOverride: motionOverride ?? null,
      });
    } catch (err) {
      const msg =
        err instanceof StreamHttpError && err.status === 422
          ? err.serverMessage || "命题检定未通过，请改写后重试"
          : err instanceof Error
            ? err.message
            : "提交失败，请重试";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <div className="stage-card__actions">
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() =>
          void submit(
            "start_debate",
            editing ? motionDraft.trim() || null : null,
          )
        }
      >
        按此开辩
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => void submit("research_first")}
      >
        先补充调研
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          setEditing((v) => !v);
          setMotionDraft(card.motion);
        }}
      >
        {editing ? "取消" : "调整命题"}
      </button>
    </div>
  );

  return (
    <PendingInteractionChrome
      title="下一步 · 开辩"
      summary={latchSummary(card.motion)}
      label="阶段推进 · 开辩"
      footer={footer}
      latchTestId="stage-card-latch"
    >
      <div className="stage-card stage-card--sheet" data-testid="stage-card">
        {editing ? (
          <textarea
            className="stage-card__motion-input"
            value={motionDraft}
            onChange={(e) => setMotionDraft(e.target.value)}
            rows={2}
            disabled={busy}
          />
        ) : (
          <div className="stage-card__motion">{card.motion}</div>
        )}
        <ul className="stage-card__sides">
          {card.sides.map((s) => (
            <li key={s.key}>
              <b>{s.name}</b> {s.stance}
            </li>
          ))}
        </ul>
        <div className="stage-card__meta">
          {FORM_LABEL[card.form] ?? card.form} ·{" "}
          {card.thorough ? "认真" : "快速"} · ≤{card.maxRounds} 轮
        </div>
        <input
          className="stage-card__note-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="开赛嘱咐（可选）"
          disabled={busy}
        />
        {error ? <p className="stage-card__error">{error}</p> : null}
      </div>
    </PendingInteractionChrome>
  );
}
