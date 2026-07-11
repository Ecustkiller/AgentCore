// 辩论轮间裁决卡 (debate_round) — 手机简化版 SteeringPanel：续辩 / 让裁判决定 / 文字引导。
import {
  type ResolveInteractionBody,
  resolveInteraction,
} from "@/api/interaction";
import {
  OrphanedInteractionCard,
  WaitingForDecisionHint,
} from "@/components/OrphanedInteractionCard";
import type { ProjectedInteraction } from "@agentcore/protocol-conformance";
import { useState } from "react";

type DebatePending = Extract<ProjectedInteraction, { kind: "debate_round" }>;

export function DebateSteeringCard({
  pending,
  conversationId,
  onResolved,
}: {
  pending: DebatePending;
  conversationId: string;
  onResolved?: () => void;
}) {
  if (pending.status === "orphaned") {
    return (
      <OrphanedInteractionCard
        title="辩论掌舵已失效"
        detail="该轮次决策已不可答复（服务已重启或回合已结束）。"
      />
    );
  }
  if (pending.status !== "pending") return null;

  return (
    <SteeringBody
      pending={pending}
      conversationId={conversationId}
      onResolved={onResolved}
    />
  );
}

function SteeringBody({
  pending,
  conversationId,
  onResolved,
}: {
  pending: DebatePending;
  conversationId: string;
  onResolved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState("");

  async function submit(decision: "continue" | "conclude") {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const body: ResolveInteractionBody = {
        kind: "debate_round",
        decision,
        focus: decision === "continue" ? focus.trim() : "",
        ask: "",
        ask_target: "",
      };
      await resolveInteraction(conversationId, pending.id, body);
      onResolved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "提交失败");
      setBusy(false);
    }
  }

  const judgeHint = pending.converged ? "裁判：本轮已收敛" : "裁判：建议再辩";
  const rationale = pending.rationale
    ? `${judgeHint}（${pending.rationale}）`
    : judgeHint;

  return (
    <div className="pause">
      <div className="pause-title">辩论掌舵 · 第 {pending.roundNo} 轮</div>
      {pending.focus && (
        <div className="pause-question">焦点：{pending.focus}</div>
      )}
      {pending.summary && (
        <div className="pause-context">{pending.summary}</div>
      )}
      <div className="pause-context">{rationale}</div>
      <WaitingForDecisionHint />
      <textarea
        className="pause-note"
        rows={2}
        value={focus}
        disabled={busy}
        placeholder="可选 · 续辩时加一个角度 / 议题"
        onChange={(e) => setFocus(e.target.value)}
      />
      <div className="pause-actions">
        <button
          type="button"
          className="pause-btn pause-btn-primary"
          disabled={busy}
          onClick={() => void submit("continue")}
        >
          再辩一轮
        </button>
        <button
          type="button"
          className="pause-btn pause-btn-neutral"
          disabled={busy}
          onClick={() => void submit("conclude")}
        >
          让裁判决定
        </button>
      </div>
      {busy && <div className="pause-busy">处理中…</div>}
      {err && <div className="error pause-err">{err}</div>}
    </div>
  );
}
