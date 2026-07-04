import { debateSignalPill } from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Gavel, Loader2, TriangleAlert } from "lucide-react";
import {
  type DebateForm,
  type DebateRoundModel,
  type DebateScoreView,
  describeRoundVerdict,
  modelVendorLabel,
  roundSignal,
} from "../model";

/** 主持人身份头像（法槌 · 中性色圆底）—— 与用户 {@link UserRound} 图标头像同构，标识「主持人是
 *  角色、非选手」；中性色（非身份色 / 非 primary）不与辩手身份色或「进行中」状态色竞争。逐轮小结与
 *  流末终审共用同一头像，让全场主持人身份恒定一致。**悬浮说明**点明主持人是「中立强模型、全程不
 *  参与对战、只做裁判」（已知驱动模型则并入厂商名）——把这层「它不是选手、别当第 N 方」的语义补足
 *  （回应用户），也顺带做 SR `aria-label`。 */
export function ModeratorAvatar({ model }: { model?: string | null }) {
  const vendor = modelVendorLabel(model);
  const label = vendor
    ? `主持人 · 由${vendor}驱动的中立强模型，全程不参与对战、只做裁判`
    : "主持人 · 中立强模型，全程不参与对战、只做裁判";
  return (
    <SimpleTooltip label={label}>
      <span
        className="mt-0.5 flex size-7 shrink-0 cursor-help items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-label={label}
      >
        <Gavel size={15} />
      </span>
    </SimpleTooltip>
  );
}

/**
 * 主持人的一句短旁白气泡（靠左·与 {@link ModeratorSpeech} 同外形，只是正文是单句、无裁判 pill）——
 * 承载「会说话的主持人」的**开场白**（全场顶部定调）与**换轮点题**（第 2 轮起每轮开头「这一轮看什么」）。
 * 与逐轮小结共用法槌头像 + 中性灰气泡，让主持人全程是「群里说话的同一个人」。纯渲染。
 */
export function ModeratorNote({
  moderatorModel,
  text,
}: {
  moderatorModel?: string;
  text: string;
}) {
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] gap-2">
        <ModeratorAvatar model={moderatorModel} />
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted/40">
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
            <span className="text-xs font-medium text-foreground">主持人</span>
          </div>
          <p className="px-3 pb-2 pt-0.5 text-sm text-foreground">{text}</p>
        </div>
      </div>
    </div>
  );
}

/** 一方的记分 chip（记分裁判 P2）—— 主持人小结元信息行内、与信号 pill 并排（C 收口）：净分 + 身份色
 *  描边，悬浮展开三维（论点强度 / 回应完整度 / 证据充分度）+ 罚分明细；罚分>0 挂一枚警示图标。记分逐轮
 *  累计驱动收场倾向（{@link tallyScores} → {@link Scoreboard}），倾向由实际交锋而非拍脑袋。 */
export function ScoreChip({ score }: { score: DebateScoreView }) {
  return (
    <SimpleTooltip label={<ScoreBreakdown score={score} />}>
      <span
        className="inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
        style={{
          color: score.colorVar,
          borderColor: score.colorVar,
          backgroundColor: `color-mix(in oklch, ${score.colorVar} 12%, transparent)`,
        }}
      >
        {score.name}
        <span className="font-semibold tabular-nums">{score.total}</span>
        {score.penalties.length > 0 && (
          <TriangleAlert size={11} className="text-destructive" />
        )}
      </span>
    </SimpleTooltip>
  );
}

/** 记分明细（tooltip 内容）：三维分 + 罚分清单 + 一句记分理由——把「净分怎么来的」摊开可追溯。 */
function ScoreBreakdown({ score }: { score: DebateScoreView }) {
  return (
    <div className="space-y-1 text-left">
      <div className="flex items-center gap-2">
        <span className="font-medium">{score.name}</span>
        <span className="font-semibold tabular-nums">净分 {score.total}</span>
      </div>
      <div className="text-xs opacity-90">
        论点 {score.argument} · 回应 {score.engagement} · 证据 {score.evidence}
      </div>
      {score.penalties.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {score.penalties.map((p) => (
            <li key={p} className="flex items-start gap-1">
              <TriangleAlert size={10} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                {p} <span className="opacity-80">(-1)</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {score.note && <p className="text-xs opacity-80">{score.note}</p>}
    </div>
  );
}

/**
 * 主持人逐轮发言（靠左·与辩手同列的第一类参与者）—— 把原「居中系统消息」升级为「头像 + 发言」气泡：
 * 法槌头像 +「主持人」身份 + 本轮小结 + 底部一句「人话」轮状态（{@link describeRoundVerdict}：融合
 * 交锋质量 × 收敛 × 收尾原因，根治「各说各话 + 已收敛」并列自相矛盾）。中性 Gavel 头像 + 灰底气泡 +
 * 无身份色名 pill，与辩手（身份色字母头像 + `bg-card`）区分。驱动模型不再逐轮挂徽章（重复噪音）——
 * 收在头像悬浮说明 + 流末终审一次呈现。逐轮无独立主持人 run，故不做钻取（裁决过程钻取归流末
 * {@link FinalVerdict}）。纯渲染。
 */
export function ModeratorSpeech({
  round,
  form,
  moderatorModel,
}: {
  round: DebateRoundModel;
  form: DebateForm;
  moderatorModel: string;
}) {
  const v = round.verdict;
  const status = v ? describeRoundVerdict(v, form) : null;
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] gap-2">
        <ModeratorAvatar model={moderatorModel} />
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted/40">
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
            <span className="text-xs font-medium text-foreground">主持人</span>
          </div>
          <p className="px-3 pb-1 pt-0.5 text-sm text-foreground">
            {round.summary}
          </p>
          {(status || round.scores.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 pt-1">
              {status && (
                <SimpleTooltip label={status.hint}>
                  <span className={debateSignalPill[roundSignal(round)]}>
                    {status.label}
                  </span>
                </SimpleTooltip>
              )}
              {round.scores.map((s) => (
                <ScoreChip key={s.sideKey} score={s} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 主持人小结在途占位（直播态·本轮各方发言已全部落定、但裁判/小结尚未到）—— 补上「主持人正在
 *  小结…」的在场反馈，免得发言完到裁决出现前那段空窗看着像卡住。收场 / 已裁判轮由
 *  {@link ModeratorSpeech} 接管，本占位只在进行中那一轮的空窗期出现。 */
export function ModeratorPending() {
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] gap-2">
        <ModeratorAvatar />
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted/40">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            主持人正在小结本轮…
          </div>
        </div>
      </div>
    </div>
  );
}
