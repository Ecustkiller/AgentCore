import { Markdown } from "@/components/chat/Markdown";
import { Button, Textarea } from "@/components/ui";
import {
  countPillMuted,
  debateSignalPill,
  statusAccentText,
  statusPillInline,
  surfaceSubtle,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { agentColorVar } from "@/lib/agentIdentity";
import { notifyError } from "@/lib/toast";
import {
  type DebateRoundUserDecision,
  decideDebateRound,
} from "@/services/debate";
import { useDebateTake, useDebateUserTake } from "@/stores/debateUserTake";
import type {
  DebateRoundDecision,
  Execution,
  RunNode,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import type { DebateUserInterjection } from "@/types/events";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CornerDownRight,
  Gavel,
  GitCompare,
  Hand,
  Info,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Scale,
  Swords,
  UserRound,
  Users,
} from "lucide-react";
import { type ReactNode, type Ref, useRef, useState } from "react";
import { BriefCard, RoundtableSpectrum } from "./Brief";
import { CollapsibleSpeech } from "./CollapsibleSpeech";
import { DebateContinue } from "./Continue";
import { ModelBadge } from "./ModelBadge";
import { SideIdentity, SideNamePill } from "./SideChip";
import {
  type DebateClashView,
  type DebateForm,
  type DebateModel,
  type DebateRoundModel,
  type DebateSideModel,
  debateFormBlurb,
  debateRoster,
  describeRoundVerdict,
  isFlatRound,
  modelVendorLabel,
  roundSignal,
  toDebateModel,
} from "./model";

/**
 * 统一辩论室（IM 群聊）—— 把整场辩论收敛成**单条群聊时间线**，按**自然时序**排布（议题头 → 逐轮
 * 交锋 → 主持人终审）：live 与收场是同一条流的「未完成 / 已完成」（单组件 + {@link toDebateModel} 归一，
 * 沿用现成、不重挂）。辩手发言=成员气泡（全靠左，身份色头像分阵营）、用户追问=右侧消息、主持人小结/
 * 裁判=靠左发言气泡（法槌中性色头像+发言，与辩手同列的第一类参与者）、L3 交锋=引用回复、**结论=流末「主持人终审」唯一面**（结论是过程的终点，不前置
 * 剧透；顶部只留 形态+状态+阵营 + 「结论 ↓」锚）。一套布局覆盖正反 / 红队 / 圆桌全形态（对抗感靠阵营色
 * + 引用回复，不靠左右分栏）。设计见 [`前端UX设计.md §4.1`](/docs/04-前端/前端UX设计.md)。
 * **纯渲染层、不碰协议 fold / conformance**。
 *
 * 这是辩论的**唯一主视图**（旧 DebateBody / LiveChat / Narrative 已退场）：单流 + 议题头 + 轮分割 +
 * 引用回复 + 系统消息 + 流末终审（{@link FinalVerdict}）+ **在群聊里直接追问/叫停/继续**（边界
 * {@link SteeringBar}，复用 {@link decideDebateRound} 同一桥）+ **站队气泡投票**（{@link StanceVote}，
 * 会话内态）。擂台降级为放大态统一「对比」透镜的辩论纵览（{@link import("../compare/DebateOverview").DebateOverview}）。
 *
 * 掌舵需 `conversationId`（决策回传）+ `interactive`（本回合 live 且未重载——决策卡 transport-only，
 * 重载即失）：二者由 {@link import("../../graph/CanvasZoomedTurn").CanvasZoomedTurn} 据焦点回合算出
 * 透传（与画布指挥台读 isStreaming 同口径）。群聊是辩论掌舵的唯一处（指挥台不再重复出辩论决策卡，
 * 前端UX设计.md §4.3）。
 */
export function DebateStream({
  execution,
  messageId,
  conversationId,
  interactive,
}: {
  execution: Execution;
  messageId: string;
  /** 决策回传的会话 id（无则掌舵只读，不发起）。 */
  conversationId: string | null;
  /** 本回合 live 且非重载 → 掌舵可操作；否则待掌舵处只读（决策卡 transport-only）。 */
  interactive: boolean;
}) {
  const model = toDebateModel(execution);
  if (!model) return null;
  return (
    <DebateStreamInner
      model={model}
      execution={execution}
      messageId={messageId}
      conversationId={conversationId}
      interactive={interactive}
    />
  );
}

const FORM_META: Record<DebateForm, { label: string; Icon: typeof Scale }> = {
  debate: { label: "正反辩论", Icon: Scale },
  red_team: { label: "红队审查", Icon: Swords },
  roundtable: { label: "圆桌探讨", Icon: Users },
};

/** 辩论收场原因 → 中文（镜像后端 STOP_REASONS）。未知原样渲染。 */
const STOP_LABELS: Record<string, string> = {
  converged: "已收敛",
  focus_clarified: "已澄清为价值之争",
  red_team_exhausted: "风险已挖尽",
  max_rounds: "达轮次上限",
  all_failed: "发言失败提前终止",
  user_concluded: "你叫停出结论",
};

function stopLabel(reason: string | null): string {
  if (!reason) return "已收场";
  return STOP_LABELS[reason] ?? reason;
}

function DebateStreamInner({
  model,
  execution,
  messageId,
  conversationId,
  interactive,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
  conversationId: string | null;
  interactive: boolean;
}) {
  // 辩题已在画布顶栏常驻（taskSummary）；与之同文的轮焦点不再在分割线重复。
  const topicMotion = model.motion ?? model.rounds[0]?.focus ?? "";
  const { Icon, label } = FORM_META[model.form] ?? FORM_META.debate;
  // 本会话已提交的追问（live 乐观回显）：追问的权威 verbatim 复盘仅收场才到（live 孪生不带，见
  // model.ts），故 live 段把刚发出的追问就地补成右侧气泡，IM「发出即可见」。收场切走 → 由权威
  // userInterjections 承载，乐观件不再渲染（不重复）。
  const [sentAsks, setSentAsks] = useState<SentAsk[]>([]);
  // 结论归位流末（自然时序：议题头 → 逐轮交锋 → 主持人终审）。顶部「结论 ↓」锚滚到流末终审，
  // 服务「只想看结论」的老板，零内容重复（BLUF 另由主聊天 CEO 综述气泡承担）。
  const verdictRef = useRef<HTMLDivElement>(null);
  const roster = rosterChips(model);
  // 主持人驱动模型（真·多模型：中立强模型，如 DeepSeek）——收场由 moderator run 补回（run.model
  // 完成才有），进行中为空（不显徽章）。逐轮小结与流末终审共用同一主持人身份。
  const moderatorModel =
    (model.moderatorRunId
      ? execution.runs.find((r) => r.id === model.moderatorRunId)?.model
      : null) ?? "";
  // 站队投票每方只在其**最新一轮**气泡出一次（同一方各轮联动同一倾向态，逐轮各挂一枚是重复噪音）：
  // 预扫各方最后出现的轮号（rounds 有序，末次赋值即最大轮号）。
  const lastRoundBySideKey = new Map<string, number>();
  for (const r of model.rounds) {
    for (const s of r.sides) {
      if (s.sideKey) lastRoundBySideKey.set(s.sideKey, r.roundNo);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      {/* 辩论室头：形态 + 状态 + 阵营 + 结论锚（辩题已在画布顶栏不重复；结论不前置、归位流末）。 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon size={14} className={`shrink-0 ${statusAccentText.primary}`} />
          <span className="text-sm font-medium text-foreground">{label}</span>
          <SimpleTooltip label={debateFormBlurb(model.form)}>
            <span
              className="inline-flex shrink-0 cursor-help text-muted-foreground"
              aria-label="这场辩论是什么"
            >
              <Info size={13} />
            </span>
          </SimpleTooltip>
          {model.settled ? (
            <SimpleTooltip label="辩论收场原因">
              <span className={countPillMuted}>
                {stopLabel(model.stopReason)}
              </span>
            </SimpleTooltip>
          ) : (
            <span className={statusPillInline.primary}>进行中</span>
          )}
          <span className="min-w-0 flex-1" />
          {model.settled && (
            <SimpleTooltip label="跳到流末主持人终审">
              <Button
                variant="ghost"
                onClick={() =>
                  verdictRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  })
                }
                className="h-auto px-1 py-0 text-xs text-muted-foreground hover:bg-transparent"
                icon={<ArrowDown size={14} />}
              >
                结论
              </Button>
            </SimpleTooltip>
          )}
        </div>
        {/* 阵营条 = 这场「谁是哪个模型」地图（真·多模型辩论的核心可读性）：每方一次名字 + 驱动模型
            徽章，glanceable 于顶部——发言气泡内不再逐轮重复模型徽章（减噪）。 */}
        {roster.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {roster.map((r) => (
              <SideIdentity
                key={r.name}
                name={r.name}
                colorVar={r.colorVar}
                model={r.model}
              />
            ))}
          </div>
        )}
      </div>

      {/* 主流：逐轮群聊。 */}
      <div className="space-y-4">
        {model.rounds.map((round) => (
          <StreamRound
            key={round.roundNo}
            round={round}
            execution={execution}
            messageId={messageId}
            topicMotion={topicMotion}
            form={model.form}
            moderatorModel={moderatorModel}
            lastRoundBySideKey={lastRoundBySideKey}
          />
        ))}
      </div>

      {/* 进行中：流末掌舵段（乐观追问回显 + 边界掌舵行动条）。 */}
      {!model.settled && (
        <SteeringSection
          model={model}
          execution={execution}
          conversationId={conversationId}
          interactive={interactive}
          sentAsks={sentAsks}
          onAskSent={(ask) => setSentAsks((prev) => [...prev, ask])}
        />
      )}

      {/* 流末「主持人终审」= 唯一结论面（结论先行已让位给自然时序）+ 续辩入口（收场）。 */}
      {model.settled && (
        <>
          <FinalVerdict
            model={model}
            execution={execution}
            messageId={messageId}
            verdictRef={verdictRef}
          />
          <DebateContinue model={model} />
        </>
      )}
    </div>
  );
}

/** 阵营条用的身份芯片（收场取 roster，进行中从各轮发言并集去重补回）。`model` 是该方驱动模型
 *  （收场 roster 权威、进行中为空）——供顶部阵营条渲染「谁是哪个模型」徽章。 */
function rosterChips(
  model: DebateModel,
): { name: string; colorVar: string; model: string }[] {
  if (model.sides && model.sides.length > 0) {
    return model.sides.map((s) => ({
      name: s.name,
      colorVar: agentColorVar(s.name),
      model: s.model ?? "",
    }));
  }
  const seen = new Set<string>();
  const out: { name: string; colorVar: string; model: string }[] = [];
  for (const r of model.rounds) {
    for (const s of r.sides) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ name: s.name, colorVar: s.colorVar, model: s.model });
    }
  }
  return out;
}

/** 一轮：轮分割线 → 用户追问（右侧·驱动本轮）→ 各方发言气泡（左·引用回复）→ 主持人发言气泡（左）。 */
function StreamRound({
  round,
  execution,
  messageId,
  topicMotion,
  form,
  moderatorModel,
  lastRoundBySideKey,
}: {
  round: DebateRoundModel;
  execution: Execution;
  messageId: string;
  topicMotion?: string;
  form: DebateForm;
  /** 主持人驱动模型（真·多模型徽章）；进行中为空。 */
  moderatorModel: string;
  /** 各方最后出现的轮号：站队投票只在该方最新一轮气泡出一次（去逐轮重复）。 */
  lastRoundBySideKey: Map<string, number>;
}) {
  const flat = isFlatRound(round);
  // 本轮所有发言均已落定（无在飞、且各方 run 都已终态）但裁判/小结未到 → 补主持人小结占位。
  const allDone =
    round.sides.length > 0 &&
    round.sides.every((s) => s.run && s.run.status !== "running");
  const showModeratorPending = round.inFlight && allDone;
  return (
    <div className="space-y-2.5">
      {!flat && round.roundNo >= 1 && (
        <RoundDivider round={round} topicMotion={topicMotion} />
      )}
      {round.userInterjections.map((it, i) => (
        <InterjectionBubble
          key={`${it.ask}-${i}`}
          interjection={it}
          sides={round.sides}
        />
      ))}
      {round.sides.map((side) => (
        <SpeechBubble
          key={side.key}
          side={side}
          round={round}
          execution={execution}
          messageId={messageId}
          showStance={
            !!side.sideKey &&
            lastRoundBySideKey.get(side.sideKey) === round.roundNo
          }
        />
      ))}
      {round.summary && !round.inFlight ? (
        <ModeratorSpeech
          round={round}
          form={form}
          moderatorModel={moderatorModel}
        />
      ) : (
        showModeratorPending && <ModeratorPending />
      )}
    </div>
  );
}

/** 轮分割线（居中）：第 N 轮 + 焦点（与辩题同文则省）+ 进行中 pill（收敛态归位流末主持人系统消息）。 */
function RoundDivider({
  round,
  topicMotion,
}: {
  round: DebateRoundModel;
  topicMotion?: string;
}) {
  const focusText =
    round.focus && round.focus !== topicMotion ? round.focus : "";
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          第 {round.roundNo} 轮
        </span>
        {focusText && (
          <span className="max-w-[20rem] truncate">· {focusText}</span>
        )}
        {round.inFlight && (
          <span className={statusPillInline.primary}>进行中</span>
        )}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 一方的发言气泡（观察者群聊：辩手一律靠左）：身份头像 + 头（点钻右坞完整产出）+ 引用回复（本方
 * 反驳了谁的哪句）+ 正文。流式中渲染纯文本 + 闪烁光标，完成后渲染 markdown。 */
function SpeechBubble({
  side,
  round,
  execution,
  messageId,
  showStance,
}: {
  side: DebateSideModel;
  round: DebateRoundModel;
  execution: Execution;
  messageId: string;
  /** 是否在本气泡出站队投票（每方只在其最新一轮出一次，去逐轮重复）。 */
  showStance: boolean;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const run = side.run;
  const agent = run
    ? execution.agents.find((a) => a.id === run.agentId)
    : undefined;
  const output = agent ? agent.outputChunks.join("") : "";
  const streaming = run?.status === "running";
  // 本方作为「反驳方」(from) 的交锋边 → 引用回复（驳了谁的哪句）。
  const replies = round.clashes.filter((c) => c.fromKey === side.sideKey);

  const status = streaming ? (
    <output
      aria-live="polite"
      className={`ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium ${statusAccentText.primary}`}
    >
      <span className="size-1.5 animate-pulse rounded-full bg-current" />
      正在输入…
    </output>
  ) : run?.status === "failed" ? (
    <span className="ml-auto shrink-0 text-xs text-destructive">发言失败</span>
  ) : null;

  // 模型徽章不再逐轮挂在发言气泡（重复噪音）——「谁是哪个模型」已收在顶部阵营条一次性呈现。
  const header = (
    <span className="flex w-full items-center gap-1.5 text-left">
      <SideNamePill name={side.name} colorVar={side.colorVar} />
      {status}
    </span>
  );

  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] gap-2">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          style={{
            color: side.colorVar,
            backgroundColor: `color-mix(in oklch, ${side.colorVar} 16%, transparent)`,
          }}
          aria-hidden
        >
          {side.name.slice(0, 1)}
        </span>
        <div
          className="min-w-0 overflow-hidden rounded-xl border border-t-2 border-border bg-card"
          style={{ borderTopColor: side.colorVar }}
        >
          {run ? (
            <SimpleTooltip label="查看完整产出">
              <Button
                variant="ghost"
                onClick={() => showRunDetail(messageId, run.id, side.name)}
                className="h-auto w-full justify-start gap-1.5 rounded-none px-3 pb-1 pt-2 hover:bg-transparent"
              >
                {header}
              </Button>
            </SimpleTooltip>
          ) : (
            <div className="px-3 pb-1 pt-2">{header}</div>
          )}
          {replies.map((c, i) => (
            <ReplyQuote key={`${c.toKey}-${i}`} clash={c} />
          ))}
          <div className={`px-3 pt-1 ${showStance ? "pb-1.5" : "pb-2.5"}`}>
            {streaming ? (
              <div className="whitespace-pre-wrap break-words text-sm text-foreground">
                {output}
                <span
                  className="ml-0.5 inline-block h-[1em] w-px animate-pulse align-text-bottom"
                  style={{ backgroundColor: side.colorVar }}
                  aria-hidden
                />
              </div>
            ) : output ? (
              <CollapsibleSpeech contentKey={output}>
                <Markdown content={output} />
              </CollapsibleSpeech>
            ) : (
              <p className="text-xs text-muted-foreground">
                {speechPlaceholder(run)}
              </p>
            )}
          </div>
          {showStance && side.sideKey && (
            <div className="flex px-3 pb-2">
              <StanceVote
                turnId={messageId}
                sideKey={side.sideKey}
                name={side.name}
                colorVar={side.colorVar}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 站队投票 chip（发言气泡底 · 前端UX设计.md §4.1 蓝图：站队=气泡投票）—— 在某辩手气泡上标记
 * 你倾向这一方（再点取消）。纯用户侧记录、仅你可见、**不影响 AI 裁决**（守中立）；按语义 `sideKey`
 * 记入 {@link useDebateUserTake}（**会话内态、不持久化**）。同一方各轮气泡共享同一倾向态（点亮一致）。
 */
function StanceVote({
  turnId,
  sideKey,
  name,
  colorVar,
}: {
  turnId: string;
  sideKey: string;
  name: string;
  colorVar: string;
}) {
  const stance = useDebateTake(turnId).stance;
  const setStance = useDebateUserTake((s) => s.setStance);
  const active = stance === sideKey;
  return (
    <SimpleTooltip label="你的倾向 · 仅你可见，不影响 AI 裁决">
      <button
        type="button"
        onClick={() => setStance(turnId, active ? null : sideKey)}
        aria-pressed={active}
        aria-label={active ? `取消倾向${name}` : `倾向${name}`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors ${
          active
            ? ""
            : "border-border text-muted-foreground hover:text-foreground"
        }`}
        style={
          active
            ? {
                color: colorVar,
                borderColor: colorVar,
                backgroundColor: `color-mix(in oklch, ${colorVar} 14%, transparent)`,
              }
            : undefined
        }
      >
        <Hand size={12} />
        {active ? "你倾向这方" : "站这方"}
      </button>
    </SimpleTooltip>
  );
}

/** L3 交锋 = 引用回复：在反驳方气泡顶部引一句「回 X：要点」，按被驳方身份色着色。 */
function ReplyQuote({ clash }: { clash: DebateClashView }) {
  return (
    <div
      className="mx-3 mt-1.5 flex items-start gap-1 rounded-lg border-l-2 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      style={{ borderLeftColor: clash.toColorVar }}
    >
      <CornerDownRight size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium" style={{ color: clash.toColorVar }}>
          回 {clash.toName}
        </span>
        ：{clash.point}
      </span>
    </div>
  );
}

/** 用户追问气泡（右侧·第三方）的共用外形：用户头像 + 「你（追问）」+ 对象 pill + 原文 + 状态。
 *  收场权威复盘（{@link InterjectionBubble}）与 live 乐观回显（{@link PendingAskBubble}）共用这
 *  一个外形，仅「对象文案 + 状态 pill」不同，避免两处近乎重复的气泡结构日久漂移。 */
function AskBubble({
  ask,
  targetLabel,
  status,
}: {
  ask: string;
  targetLabel: string;
  status: ReactNode;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-row-reverse gap-2">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          aria-hidden
        >
          <UserRound size={15} />
        </span>
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted/40">
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
            <span className="text-xs font-medium text-foreground">
              你（追问）
            </span>
            <span className={countPillMuted}>{targetLabel}</span>
          </div>
          <p className="px-3 text-sm text-foreground">{ask}</p>
          <div className="px-3 pb-2 pt-1">{status}</div>
        </div>
      </div>
    </div>
  );
}

/** 用户追问气泡（右侧·第三方）：驱动本轮的「你的追问」权威复盘——向谁问 + 原文 + 是否被承接。 */
function InterjectionBubble({
  interjection,
  sides,
}: {
  interjection: DebateUserInterjection;
  sides: DebateSideModel[];
}) {
  const nameBySideKey = new Map(sides.map((s) => [s.sideKey, s.name]));
  const target = interjection.target_key
    ? (nameBySideKey.get(interjection.target_key) ?? interjection.target_key)
    : null;
  return (
    <AskBubble
      ask={interjection.ask}
      targetLabel={target ? `定向：${target}` : "全场"}
      status={
        <span
          className={
            interjection.answered
              ? statusPillInline.success
              : statusPillInline.muted
          }
        >
          {interjection.answered ? "✓ 已被承接" : "未及回应"}
        </span>
      }
    />
  );
}

/** 主持人身份头像（法槌 · 中性色圆底）—— 与用户 {@link UserRound} 图标头像同构，标识「主持人是
 *  角色、非选手」；中性色（非身份色 / 非 primary）不与辩手身份色或「进行中」状态色竞争。逐轮小结与
 *  流末终审共用同一头像，让全场主持人身份恒定一致。**悬浮说明**点明主持人是「中立强模型、全程不
 *  参与对战、只做裁判」（已知驱动模型则并入厂商名）——把这层「它不是选手、别当第 N 方」的语义补足
 *  （回应用户），也顺带做 SR `aria-label`。擂台纵览 {@link import("../compare/DebateOverview").DebateOverview} 复用同一
 *  头像保持主持人身份跨视图一致。 */
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
 * 主持人逐轮发言（靠左·与辩手同列的第一类参与者）—— 把原「居中系统消息」升级为「头像 + 发言」气泡：
 * 法槌头像 +「主持人」身份 + 本轮小结 + 底部一句「人话」轮状态（{@link describeRoundVerdict}：融合
 * 交锋质量 × 收敛 × 收尾原因，根治「各说各话 + 已收敛」并列自相矛盾）。中性 Gavel 头像 + 灰底气泡 +
 * 无身份色名 pill，与辩手（身份色字母头像 + `bg-card`）区分。驱动模型不再逐轮挂徽章（重复噪音）——
 * 收在头像悬浮说明 + 流末终审一次呈现。逐轮无独立主持人 run，故不做钻取（裁决过程钻取归流末
 * {@link FinalVerdict}）。纯渲染。
 */
function ModeratorSpeech({
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
          {status && (
            <div className="px-3 pb-2 pt-1">
              <SimpleTooltip label={status.hint}>
                <span className={debateSignalPill[roundSignal(round)]}>
                  {status.label}
                </span>
              </SimpleTooltip>
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
function ModeratorPending() {
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

/** 用户在某轮边界已提交的追问（会话内本地记忆，供 live 段就地回显——权威 verbatim 仅收场到）。 */
interface SentAsk {
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
 * 流末掌舵段（进行中）—— 把「请你掌舵」这件事就地收进群聊：先回显本会话已发出的追问（乐观件），
 * 再在主持人挂起的边界出**掌舵行动条**（{@link SteeringBar}）。无挂起边界（非交互辩论 / 正辩到一半）
 * → 不出行动条；挂起但本回合已重载（interactive=false，决策卡 transport-only 已失）→ 出只读提示。
 */
function SteeringSection({
  model,
  execution,
  conversationId,
  interactive,
  sentAsks,
  onAskSent,
}: {
  model: DebateModel;
  execution: Execution;
  conversationId: string | null;
  interactive: boolean;
  sentAsks: SentAsk[];
  onAskSent: (ask: SentAsk) => void;
}) {
  const pending = execution.debateDecisions.find((d) => d.status === "pending");
  const targets: SteerTarget[] = pending
    ? (model.rounds
        .find((r) => r.roundNo === pending.roundNo)
        ?.sides.map((s) => ({ key: s.sideKey, name: s.name })) ?? [])
    : [];
  if (sentAsks.length === 0 && !pending) return null;
  return (
    <div className="space-y-2.5">
      {sentAsks.map((a, i) => (
        <PendingAskBubble key={`${a.ask}-${i}`} ask={a} />
      ))}
      {pending &&
        (interactive && conversationId ? (
          <SteeringBar
            decision={pending}
            conversationId={conversationId}
            targets={targets}
            onAskSent={onAskSent}
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
 * 边界掌舵行动条（进行中·IM 群聊底部 composer）—— 主持人在第 N 轮边界挂起、把深浅交给你：
 * 继续辩 / 加角度续辩 / 够了出结论，并可附【追问】（与角度正交，注入下一轮令辩手正面回应、可定向
 * 某方）。复用 {@link decideDebateRound}（统一桥 `kind=debate_round`），结算从 live SSE
 * `debate_round_decision_resolved` 翻面（此处不结算）——沿用既有掌舵桥，只是把卡换成 IM 行动条。
 */
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
    <div className={`rounded-xl border p-3 ${surfaceSubtle.primary}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Gavel size={14} className={`shrink-0 ${statusAccentText.primary}`} />
        <span className="text-sm font-medium text-foreground">
          第 {decision.roundNo} 轮结束 · 请你掌舵
        </span>
        <span className={countPillMuted}>{steerJudgeHint(decision)}</span>
      </div>

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
 *  （live 段权威 verbatim 复盘尚未到；收场切走由 {@link InterjectionBubble} 承载，不重复）。 */
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

/**
 * 流末「主持人终审」= 辩论的**唯一结论面**（收场）：自然时序的终点——读完逐轮交锋后，主持人在流末
 * 给出完整裁决。呈现为主持人的**收尾长发言气泡**（法槌头像 + 满宽中性气泡，与逐轮小结
 * {@link ModeratorSpeech} 同构——主持人全程是「群里说话的同一个人」，只是终审这条发言正文更丰富）。
 * 倾向 + 置信 + 建议 + 价值/事实之争分诊 +（圆桌）观点光谱全由 {@link BriefCard} /
 * {@link RoundtableSpectrum} 承载（与旧置顶结论卡同一简报体，结论不再前置剧透）；附终局「你 vs AI」
 * 站队软对照（{@link useDebateTake}，会话内态，绝不碰 AI 裁决）与「裁决过程」钻取。`verdictRef` 供
 * 顶部「结论 ↓」锚定位。
 */
function FinalVerdict({
  model,
  execution,
  messageId,
  verdictRef,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
  verdictRef: Ref<HTMLDivElement>;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const moderatorRun = model.moderatorRunId
    ? execution.runs.find((r) => r.id === model.moderatorRunId)
    : undefined;
  const brief = model.brief;
  const sides = model.sides;
  const hasBrief = !!(brief && sides);
  const valueCount = brief?.value_disputes.length ?? 0;

  // 终局站队软对照（按回合 id；会话内态。`leaning` 文本含该方名 → 看似一致，只提示不下硬判，守 AI 中立）。
  const take = useDebateTake(messageId);
  const stanceSide =
    debateRoster(model.rounds).find((r) => r.sideKey === take.stance) ?? null;
  const stanceAgree =
    stanceSide && brief?.leaning
      ? brief.leaning.includes(stanceSide.name)
      : null;

  return (
    <div ref={verdictRef} className="flex scroll-mt-2 justify-start">
      <div className="flex w-full gap-2">
        <ModeratorAvatar model={moderatorRun?.model} />
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted/40">
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1 pt-2">
            <span className="text-sm font-medium text-foreground">
              主持人终审
            </span>
            <ModelBadge model={moderatorRun?.model ?? ""} />
            <span className={countPillMuted}>
              {stopLabel(model.stopReason)}
            </span>
            {valueCount > 0 && (
              <span className={countPillMuted}>价值之争 {valueCount}</span>
            )}
            <span className="min-w-0 flex-1" />
            {moderatorRun && (
              <Button
                variant="ghost"
                onClick={() =>
                  showRunDetail(messageId, moderatorRun.id, "主持人")
                }
                className="h-auto px-0 py-0 text-xs text-primary hover:bg-transparent"
              >
                裁决过程
              </Button>
            )}
          </div>

          <div className="px-3 pb-2.5 pt-1">
            {hasBrief ? (
              <div className="space-y-3">
                {model.form === "roundtable" && (
                  <RoundtableSpectrum brief={brief} sides={sides} />
                )}
                <BriefCard brief={brief} sides={sides} form={model.form} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">结论简报生成中…</p>
            )}

            {stanceAgree !== null && stanceSide && (
              <div
                className={`mt-2 inline-flex items-center gap-1 text-xs ${stanceAgree ? statusAccentText.success : statusAccentText.muted}`}
              >
                {stanceAgree ? <Check size={12} /> : <GitCompare size={12} />}
                {stanceAgree
                  ? "你的倾向与 AI 看似一致"
                  : "你的倾向与 AI 或有不同"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 发言出现前的占位文案。 */
function speechPlaceholder(run: RunNode | null): string {
  if (!run) return "等待发言…";
  if (run.status === "running") return "正在生成…";
  if (run.status === "failed") return run.error ?? "发言失败。";
  if (run.status === "cancelled") return "已停止。";
  return "等待发言…";
}
