import { Button, Textarea } from "@/components/ui";
import {
  statusAccentText,
  statusPillInline,
  surfaceSubtle,
} from "@/components/ui/tone-presets";
import { notifyError } from "@/lib/toast";
import {
  type DebateRoundUserDecision,
  decideDebateRound,
} from "@/services/debate";
import type { DebateRoundDecision, Execution } from "@/stores/execution";
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
import { useState } from "react";
import type { DebateModel } from "../model";
import { AskBubble, ModeratorAvatar } from "../stream/DebateStream";

/** 用户在某轮边界已提交的追问（会话内本地记忆，供 live 段就地回显——权威 verbatim 仅收场到）。 */
export interface SentAsk {
  ask: string;
  targetName: string | null;
}

/** 一个可追问对象（语义 key + 展示名）。 */
interface SteerTarget {
  key: string;
  name: string;
}

/** 裁判对本轮的建议（行动条把它作为默认动作高亮）：收敛→建议出结论；未收敛→建议继续。 */
function steerJudgeHint(decision: DebateRoundDecision): string {
  const lead = decision.converged ? "裁判：本轮已收敛" : "裁判：建议再辩";
  return decision.rationale ? `${lead}（${decision.rationale}）` : lead;
}

/**
 * 掌舵段（进行中·裁判台内）—— 把「请你掌舵」收进裁判台：先回显本会话已发出的追问（乐观件），再在
 * 主持人挂起的边界出**掌舵行动条**（{@link SteeringBar}）。无挂起边界（非交互辩论 / 正辩到一半）→
 * 不出行动条；挂起但本回合已重载（interactive=false，决策卡 transport-only 已失）→ 出只读提示。
 * 乐观追问件（{@link SentAsk}）为本段自持态（收场切走由流内权威 InterjectionBubble 承载，不重复）。
 */
export function SteeringSection({
  model,
  execution,
  conversationId,
  interactive,
}: {
  model: DebateModel;
  execution: Execution;
  conversationId: string | null;
  interactive: boolean;
}) {
  const [sentAsks, setSentAsks] = useState<SentAsk[]>([]);
  const pending = execution.debateDecisions.find((d) => d.status === "pending");
  const targets: SteerTarget[] = pending
    ? (model.rounds
        .find((r) => r.roundNo === pending.roundNo)
        ?.sides.map((s) => ({ key: s.sideKey, name: s.name })) ?? [])
    : [];
  if (sentAsks.length === 0 && !pending) return null;
  return (
    <div className="space-y-2.5 border-t border-border/60 pt-3">
      {sentAsks.map((a, i) => (
        <PendingAskBubble key={`${a.ask}-${i}`} ask={a} />
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
          <div className="flex items-center justify-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
            <Gavel size={12} className="shrink-0" />
            主持人曾请你掌舵第 {pending.roundNo} 轮（本回合已结束）
          </div>
        ))}
    </div>
  );
}

/**
 * 边界掌舵行动条（进行中·裁判台内 composer）—— 主持人在第 N 轮边界挂起、把深浅交给你：
 * 继续辩 / 加角度续辩 / 够了出结论，并可附【追问】（与角度正交，注入下一轮令辩手正面回应、可定向
 * 某方）。复用 {@link decideDebateRound}（统一桥 `kind=debate_round`），结算从 live SSE
 * `debate_round_decision_resolved` 翻面（此处不结算）——沿用既有掌舵桥，只是把卡换成 IM 行动条。
 */
export function SteeringBar({
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
  // 在飞动作的 label（null = 空闲），各按钮各转各的圈。
  const [submitting, setSubmitting] = useState<string | null>(null);
  const busy = submitting !== null;
  const hasAsk = ask.trim().length > 0;
  const hasAngle = angle.trim().length > 0;

  // 提交一个边界决定：continue（可带「加角度」focus）/ conclude，两者都可附【追问】（ask 非空时连同
  // ask_target 一起发，空则不带、行为同旧）。成功后把追问原文记到会话本地态，就地补成右侧气泡。
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
      .then(() => {
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
    <div className="flex justify-start">
      <div className="flex w-full gap-2">
        {/* 掌舵 = 主持人在轮边界把「深浅」交给你：复用法槌头像 + 气泡（与逐轮小结 / 流末终审同一主持人
            身份家族），气泡走 primary 淡面（surfaceSubtle·「需要你 / 行动」= primary，遵 color-tokens），
            在灰底小结里读出「该你拍板了」。 */}
        <ModeratorAvatar />
        <div
          className={`min-w-0 flex-1 rounded-xl border p-3 ${surfaceSubtle.primary}`}
        >
          {/* 掌舵头 = 全场唯一「轮到你了 · 我要参与」时刻（E 收口·轻触统一）：Hand 举手参与标（与站队气泡
              同一「参与」语汇）+ 更醒目的 semibold 标题，让「该你拍板」从灰底逐轮小结里一眼跳出；法槌头像仍
              承载主持人身份，裁判建议独立一行。 */}
          <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Hand size={14} className={statusAccentText.primary} />
            轮到你掌舵 · 第 {decision.roundNo} 轮结束
          </span>
          <p className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
            <Scale size={13} className="mt-0.5 shrink-0" />
            <span>{steerJudgeHint(decision)}</span>
          </p>

          <Textarea
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="追问辩手，让下一轮正面回答…（可选；留空＝直接继续/出结论）"
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
              placeholder="下一轮想聚焦的角度…（重设本轮焦点，与追问正交）"
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
              够了，出结论
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
      </div>
    </div>
  );
}

/** 掌舵行动条的追问对象 chip（全场 / 某方）：选中态用 primary 品牌蓝描边底色，与掌舵段同色调。 */
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

/** 乐观追问气泡（右侧·已发送）—— 你刚通过行动条发出的追问就地回显，状态「已发送 · 待下一轮回应」
 *  （live 段权威 verbatim 复盘尚未到；收场切走由流内 InterjectionBubble 承载，不重复）。 */
function PendingAskBubble({ ask }: { ask: SentAsk }) {
  return (
    <AskBubble
      ask={ask.ask}
      targetLabel={ask.targetName ? `定向：${ask.targetName}` : "全场"}
      status={
        <span className={statusPillInline.primary}>已发送 · 待下一轮回应</span>
      }
    />
  );
}
