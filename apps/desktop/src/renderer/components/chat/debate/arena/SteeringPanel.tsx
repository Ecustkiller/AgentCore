import {
  OrphanedInteractionCard,
  WaitingForDecisionHint,
} from "@/components/chat/OrphanedInteractionCard";
import { Button, Textarea } from "@/components/ui";
import { surfaceSubtle } from "@/components/ui/tone-presets";
import { notifyError } from "@/lib/toast";
import {
  type DebateRoundUserDecision,
  decideDebateRound,
} from "@/services/debate";
import type { DebateRoundDecision, Execution } from "@/stores/execution";
import {
  entryToDebateDecision,
  useInteractionStore,
} from "@/stores/interactions";
import {
  ArrowRight,
  Check,
  Gavel,
  Hand,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Scale,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DebateModel } from "../model";
import { steeringAnchorId } from "./anchors";

export interface SentAsk {
  ask: string;
  targetName: string | null;
}

interface SteerTarget {
  key: string;
  name: string;
}

function steerJudgeHint(decision: DebateRoundDecision): string {
  const lead = decision.converged ? "裁判：本轮已收敛" : "裁判：建议再辩";
  return decision.rationale ? `${lead}（${decision.rationale}）` : lead;
}

/** 掌舵面板：live 轮边界挂起时全宽 primary 淡面。 */
export function SteeringPanel({
  model,
  execution: _execution,
  conversationId,
  interactive,
}: {
  model: DebateModel;
  execution: Execution;
  conversationId: string | null;
  interactive: boolean;
}) {
  const [sentAsks, setSentAsks] = useState<SentAsk[]>([]);
  const byId = useInteractionStore((s) => s.byId);

  const { pending, orphaned } = useMemo(() => {
    let pending: DebateRoundDecision | undefined;
    const orphaned: DebateRoundDecision[] = [];
    if (!conversationId) return { pending, orphaned };
    for (const e of byId.values()) {
      if (e.conversationId !== conversationId) continue;
      if (e.kind !== "debate_round") continue;
      if (e.status === "orphaned") {
        orphaned.push(entryToDebateDecision(e));
      } else if (
        (e.status === "pending" || e.status === "submitting") &&
        !pending
      ) {
        pending = entryToDebateDecision(e);
      }
    }
    return { pending, orphaned };
  }, [byId, conversationId]);

  const targets: SteerTarget[] = pending
    ? (model.rounds
        .find((r) => r.roundNo === pending.roundNo)
        ?.sides.map((s) => ({ key: s.sideKey, name: s.name })) ?? [])
    : [];

  if (sentAsks.length === 0 && !pending && orphaned.length === 0) return null;

  return (
    <div id={steeringAnchorId()} className="scroll-mt-28 space-y-3 py-4">
      {orphaned.map((d) => (
        <OrphanedInteractionCard
          key={d.id}
          title="辩论掌舵已失效"
          detail="该轮次决策已不可答复（服务已重启或回合已结束）。"
        />
      ))}
      {sentAsks.map((a, i) => (
        <div
          key={`${a.ask}-${i}`}
          className="flex justify-end py-1 text-right text-sm"
        >
          <div>
            <p className="text-xs text-muted-foreground">
              你 · {a.targetName ? `定向 ${a.targetName}` : "全场"} · 已发送
            </p>
            <p className="text-foreground">{a.ask}</p>
          </div>
        </div>
      ))}
      {pending &&
        (interactive && conversationId ? (
          <SteeringBar
            decision={pending}
            conversationId={conversationId}
            targets={targets}
            onAskSent={(ask) => setSentAsks((prev) => [...prev, ask])}
          />
        ) : (
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Gavel size={12} />
            主持人曾请你掌舵第 {pending.roundNo} 轮（本回合已结束）
          </div>
        ))}
    </div>
  );
}

function SteeringBar({
  decision,
  conversationId,
  targets,
  onAskSent,
}: {
  decision: DebateRoundDecision;
  conversationId: string;
  targets: SteerTarget[];
  onAskSent: (ask: SentAsk) => void;
}) {
  const [ask, setAsk] = useState("");
  const [angle, setAngle] = useState("");
  const [askTarget, setAskTarget] = useState("");
  const [showAngle, setShowAngle] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const entryStatus = useInteractionStore(
    (s) => s.byId.get(decision.id)?.status,
  );
  const busy = submitting !== null || entryStatus === "submitting";
  const hasAsk = ask.trim().length > 0;
  const hasAngle = angle.trim().length > 0;

  const send = (label: string, kind: "continue" | "conclude") => {
    if (busy) return;
    const trimmedAsk = ask.trim();
    const target = trimmedAsk ? askTarget : "";
    const focus = kind === "continue" ? angle.trim() : "";
    setSubmitting(label);
    const call: DebateRoundUserDecision =
      kind === "continue"
        ? { kind, focus, ask: trimmedAsk, askTarget: target }
        : { kind, ask: trimmedAsk, askTarget: target };
    decideDebateRound(conversationId, decision.id, call)
      .then((result) => {
        if (result !== "ok") {
          setSubmitting(null);
          return;
        }
        if (trimmedAsk) {
          const targetName = target
            ? (targets.find((t) => t.key === target)?.name ?? null)
            : null;
          onAskSent({ ask: trimmedAsk, targetName });
        }
      })
      .catch((err) => {
        notifyError(err, "提交失败");
        setSubmitting(null);
      });
  };

  const continueLabel = hasAsk
    ? "追问并继续"
    : hasAngle
      ? "按此角度继续"
      : "继续辩一轮";

  return (
    <div className={`rounded-xl border p-4 ${surfaceSubtle.primary}`}>
      <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Hand size={14} className="text-muted-foreground" />
        轮到你掌舵 · 第 {decision.roundNo} 轮结束
      </span>
      <WaitingForDecisionHint />
      <p className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
        <Scale size={13} className="mt-0.5 shrink-0" />
        <span>{steerJudgeHint(decision)}</span>
      </p>

      <Textarea
        value={ask}
        onChange={(e) => setAsk(e.target.value)}
        disabled={busy}
        rows={2}
        placeholder="追问辩手，让下一轮正面回答…（可选）"
        className="mt-2 w-full border-border bg-card/70 focus:border-primary/60"
      />
      {hasAsk && targets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <MessageCircleQuestion size={12} />
            追问对象
          </span>
          <SteerChip
            label="全场"
            active={askTarget === ""}
            disabled={busy}
            onClick={() => setAskTarget("")}
          />
          {targets.map((t) => (
            <SteerChip
              key={t.key}
              label={t.name}
              active={askTarget === t.key}
              disabled={busy}
              onClick={() => setAskTarget(t.key)}
            />
          ))}
        </div>
      )}
      {showAngle && (
        <Textarea
          value={angle}
          onChange={(e) => setAngle(e.target.value)}
          disabled={busy}
          rows={2}
          placeholder="下一轮想聚焦的角度…"
          className="mt-2 w-full border-border bg-card/70 focus:border-primary/60"
        />
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Button
          variant={decision.converged ? "neutral" : "primary"}
          disabled={busy}
          onClick={() => send("continue", "continue")}
          icon={
            submitting === "continue" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : hasAsk ? (
              <MessageCircleQuestion size={13} />
            ) : (
              <ArrowRight size={13} />
            )
          }
        >
          {continueLabel}
        </Button>
        <Button
          variant={decision.converged ? "primary" : "neutral"}
          disabled={busy}
          onClick={() => send("conclude", "conclude")}
          icon={
            submitting === "conclude" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Check size={13} />
            )
          }
        >
          让裁判决定
        </Button>
        {!showAngle && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setShowAngle(true)}
            className="text-xs text-muted-foreground"
            icon={<Plus size={13} />}
          >
            加角度
          </Button>
        )}
      </div>
    </div>
  );
}

function SteerChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        active
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
