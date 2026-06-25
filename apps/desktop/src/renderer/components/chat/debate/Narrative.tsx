import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import {
  debateSignalDot,
  roundLabelPill,
  runStatusDot,
  statusAccentText,
  statusPillInline,
  surfaceMutedPanel,
  surfaceSubtle,
  textLinkPrimary,
  verdictTogglePill,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Execution, RunNode } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import type { DebateSideInfo, DebateVerdict } from "@/types/events";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  MessagesSquare,
  ShieldAlert,
  ShieldCheck,
  Swords,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ConvergenceBand } from "./ConvergenceBand";
import { SideIdentity } from "./SideChip";
import {
  type DebateClashView,
  type DebateForm,
  type DebateRoundModel,
  type DebateSideModel,
  isFlatRound,
  roundSignal,
} from "./model";

/**
 * 交锋叙事线 (方案 A · 单组件) —— 一条**竖向时间线**承载逐轮推进，live 与收场**共用**：每轮一个
 * 时间轴节点 (轴点颜色按 {@link roundSignal} 读出交锋/收敛态)，串成「认知推进线」(辩论编排设计.md
 * §4.2)。顶部挂一条 {@link ConvergenceBand} 做 glanceable 概览 (概览 ↔ 时间线 = 两级、非重复)。
 *
 * 展开策略：**默认全折到 L1，只展开在飞那轮 (流式中)**——进行中盯住当前轮的流式发言，收场后每轮
 * 折到焦点行、首屏不再爆 L3 全文 (用户反馈的「乱」之一)，过程按需逐层深读；用户可手动展开任意轮
 * (一旦交互即固定)。
 */
export function RoundList({
  rounds,
  execution,
  messageId,
  topicMotion,
  form,
  sides,
}: {
  rounds: DebateRoundModel[];
  execution: Execution;
  messageId: string;
  /** 上方辩题头展示的 motion (进行中=首轮焦点占位)。与之同文的轮焦点显示为「本轮交锋」，
   *  避免辩题与第 1 轮焦点上下重复 (用户反馈的「杂」根因之一)。 */
  topicMotion?: string;
  /** 辩论形态：驱动逐轮研判的差异化骨架 (正反=逐轮记分卡 / 红队=风险看板 / 圆桌=通用研判)。 */
  form: DebateForm;
  /** 收场 roster (含 `is_subject`)：红队据此把每轮各方分成「方案方 vs 红队」；进行中为 null。 */
  sides: DebateSideInfo[] | null;
}) {
  if (rounds.length === 0) return null;
  // 红队「方案方」语义 key 集合 (收场 roster 才有 is_subject)；用于把每轮发言/风险归边。
  const subjectKeys = new Set(
    (sides ?? []).filter((s) => s.is_subject).map((s) => s.key),
  );
  // 单条扁平旧批次 (无主持人逐轮叙事) 不挂时间线壳，直接铺正/反。
  const headless = rounds.length === 1 && isFlatRound(rounds[0]);
  if (headless) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <SidesGrid
          sides={rounds[0].sides}
          execution={execution}
          messageId={messageId}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessagesSquare size={14} />
          交锋叙事线 · {rounds.length} 轮
        </h3>
        <div className="min-w-[180px] flex-1">
          <ConvergenceBand rounds={rounds} form={form} />
        </div>
      </div>
      <ol>
        {rounds.map((round, i) => (
          <RoundCell
            key={round.roundNo}
            round={round}
            isFirst={i === 0}
            isLast={i === rounds.length - 1}
            execution={execution}
            messageId={messageId}
            topicMotion={topicMotion}
            form={form}
            subjectKeys={subjectKeys}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * 一轮 = 时间轴节点 (轴点 + 连线) + 内容卡，三层渐进披露 (辩论编排设计.md §4.2)：
 *  - **L1**：焦点 (一句话，clamp 成轴标题) + 小结 (clamp) + 收敛/进行中/交锋 标记。
 *  - **L2**：裁判徽章 + 裁判理由 + L3 开关。
 *  - **L3**：各方发言对置 (2 方左右对开 / 多方自适应双列)。
 *
 * 展开默认 = `round.inFlight` (仅在飞轮自动展开，收场全折)。用户点击落到本地 override、**一旦交互
 * 即固定**，不随新轮自动折叠。轮号作 React key → live→收场 同号轮复用同一实例，展开态与已展开的
 * 发言**无缝延续**、不重挂。
 */
/** 一条被点选的交锋边：选中的 clash 下标 + 触发序号 (重复点同一条也能再次滚动定位)。 */
interface PickedClash {
  idx: number;
  nonce: number;
}

/** 轮焦点缺省占位 (无焦点 / 焦点与辩题同文时) 按形态分：交锋 / 风险切入 / 讨论。 */
const FOCUS_FALLBACK: Record<DebateForm, string> = {
  debate: "本轮交锋",
  red_team: "本轮风险切入",
  roundtable: "本轮讨论",
};

/** L1 收敛 pill 文案按形态分：红队的「收敛」语义是「风险已挖尽」。 */
const CONVERGED_LABEL: Record<DebateForm, string> = {
  debate: "已收敛",
  red_team: "已挖尽",
  roundtable: "已收敛",
};

/** L3 发言开关文案按形态分：红队展开的是「风险与抗辩」。 */
const SPEECH_TOGGLE: Record<DebateForm, { show: string; hide: string }> = {
  debate: { show: "展开各方发言", hide: "收起各方发言" },
  red_team: { show: "展开风险与抗辩", hide: "收起风险与抗辩" },
  roundtable: { show: "展开各方发言", hide: "收起各方发言" },
};

function RoundCell({
  round,
  isFirst,
  isLast,
  execution,
  messageId,
  topicMotion,
  form,
  subjectKeys,
}: {
  round: DebateRoundModel;
  isFirst: boolean;
  isLast: boolean;
  execution: Execution;
  messageId: string;
  topicMotion?: string;
  form: DebateForm;
  subjectKeys: ReadonlySet<string>;
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [speechOverride, setSpeechOverride] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<PickedClash | null>(null);

  // 默认全收起到 L1，只让**在飞那轮**（流式中）自动展开——根治旧「默认展开最后一轮、首屏直接铺
  // L3 全文发言、信息量爆炸」（用户反馈）。收场后每轮折到焦点行，过程按需逐层深读；用户一旦手动
  // 展开即落本地 override 固定，不随新轮自动折叠。
  const open = openOverride ?? round.inFlight;
  const showSpeeches = open && (speechOverride ?? round.inFlight);

  // 点一条交锋边 → 把它当成「引用连线」：展开本轮发言 (L3) 并高亮 + 滚动定位涉及的两方发言格，
  // 让「反方在驳正方哪点」从一句话变成可直达发言的导航 (辩论编排设计.md §4.2 L3)。
  const pickClash = (idx: number) => {
    setSpeechOverride(true);
    setPicked({ idx, nonce: Date.now() });
  };
  const pickedClash =
    picked && picked.idx < round.clashes.length
      ? round.clashes[picked.idx]
      : null;
  const highlightKeys = pickedClash
    ? ([pickedClash.fromKey, pickedClash.toKey] as const)
    : null;
  const focusText =
    round.focus && round.focus !== topicMotion
      ? round.focus
      : FOCUS_FALLBACK[form];

  return (
    <li className="relative flex gap-3">
      {/* 时间轴：轴点 (信号色) + 上下连线，串成「认知推进线」。 */}
      <div className="relative flex w-3 shrink-0 flex-col items-center">
        {!isFirst && (
          <span
            className="absolute bottom-full left-1/2 h-2.5 w-px -translate-x-1/2 bg-border"
            aria-hidden
          />
        )}
        <span
          className={`z-10 mt-1.5 size-3 shrink-0 rounded-full ring-4 ring-background ${debateSignalDot[roundSignal(round)]}`}
        />
        {!isLast && <span className="mt-1 w-px flex-1 bg-border" aria-hidden />}
      </div>

      {/* 内容卡。 */}
      <div className="min-w-0 flex-1 pb-4">
        <div className={surfaceMutedPanel}>
          {/* L1: 焦点行 (点击展开本轮)。 */}
          <button
            type="button"
            onClick={() => setOpenOverride(!open)}
            className={`flex w-full items-center gap-2 px-3 pt-3 text-left ${
              round.summary ? "" : "pb-3"
            }`}
            aria-expanded={open}
          >
            {round.roundNo >= 1 && (
              <span className={roundLabelPill}>第 {round.roundNo} 轮</span>
            )}
            <span
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              title={focusText}
            >
              {focusText}
            </span>
            {round.verdict?.converged && (
              <span className={statusPillInline.success}>
                {CONVERGED_LABEL[form]}
              </span>
            )}
            {round.inFlight && (
              <span className={statusPillInline.primary}>进行中</span>
            )}
            {open ? (
              <ChevronUp size={14} className="shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown
                size={14}
                className="shrink-0 text-muted-foreground"
              />
            )}
          </button>

          {/* L1: 小结 (折叠时 clamp，展开时全文)。 */}
          {round.summary && (
            <p
              className={`px-3 pt-1.5 text-sm text-muted-foreground ${
                open ? "pb-2" : "pb-3 line-clamp-2"
              }`}
            >
              {round.summary}
            </p>
          )}

          {/* L2: 逐轮研判 (按形态差异化) + 理由 + 交锋点 + L3 开关。 */}
          {open && (
            <div className="px-3 pb-3">
              <RoundJudgment
                form={form}
                round={round}
                subjectKeys={subjectKeys}
                selectedClashIdx={picked?.idx ?? null}
                onPickClash={pickClash}
              />
              {round.sides.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={() => setSpeechOverride(!showSpeeches)}
                  className={`mt-2 h-auto px-0 py-0 ${textLinkPrimary} hover:bg-transparent`}
                  icon={
                    showSpeeches ? (
                      <ChevronUp size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )
                  }
                >
                  {showSpeeches
                    ? SPEECH_TOGGLE[form].hide
                    : `${SPEECH_TOGGLE[form].show}（${round.sides.length}）`}
                </Button>
              )}
            </div>
          )}

          {/* L3: 各方发言对置。 */}
          {open && showSpeeches && round.sides.length > 0 && (
            <div className="border-t border-border p-3">
              <SidesGrid
                sides={round.sides}
                execution={execution}
                messageId={messageId}
                highlightKeys={highlightKeys}
                highlightNonce={picked?.nonce ?? 0}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * 逐轮研判区——按形态差异化骨架 (主张⑤)：正反=逐轮记分卡、红队=风险看板、圆桌=通用研判。三者共用
 * 「裁判理由 + 可点交锋边 (点击→展开发言并定位)」的底座，仅「判定」的取景与措辞按形态分；进行中
 * 当前轮 (verdict 尚空) 各形态都只剩交锋点 (恒空) → 自然留白，与 L1 的「进行中」呼应。
 */
function RoundJudgment({
  form,
  round,
  subjectKeys,
  selectedClashIdx,
  onPickClash,
}: {
  form: DebateForm;
  round: DebateRoundModel;
  subjectKeys: ReadonlySet<string>;
  selectedClashIdx: number | null;
  onPickClash: (idx: number) => void;
}) {
  if (form === "red_team") {
    return (
      <RoundRiskBoard
        round={round}
        subjectKeys={subjectKeys}
        selectedClashIdx={selectedClashIdx}
        onPickClash={onPickClash}
      />
    );
  }
  if (form === "debate") {
    return (
      <RoundScorecard
        round={round}
        selectedClashIdx={selectedClashIdx}
        onPickClash={onPickClash}
      />
    );
  }
  return (
    <RoundDiscussion
      round={round}
      selectedClashIdx={selectedClashIdx}
      onPickClash={onPickClash}
    />
  );
}

/** 逐轮研判子组件的公共入参：本轮模型 + 当前选中交锋边 + 点选回调 (透传给 {@link ClashList})。 */
interface RoundVerdictProps {
  round: DebateRoundModel;
  selectedClashIdx: number | null;
  onPickClash: (idx: number) => void;
}

/**
 * 圆桌探讨·通用研判 (= 旧版骨架)：裁判徽章 (交锋 / 新论据) + 理由 + 交锋点。探讨无「赢家」，
 * 故沿用中性徽章——形态差异主要由叙事之前的「观点光谱」英雄区承载 (见 `Brief.tsx`)。
 */
function RoundDiscussion({
  round,
  selectedClashIdx,
  onPickClash,
}: RoundVerdictProps) {
  return (
    <>
      {round.verdict && <VerdictBadges verdict={round.verdict} hideConverged />}
      {round.verdict?.rationale && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          裁判：{round.verdict.rationale}
        </p>
      )}
      {round.clashes.length > 0 && (
        <ClashList
          clashes={round.clashes}
          selectedIdx={selectedClashIdx}
          onPick={onPickClash}
        />
      )}
    </>
  );
}

/**
 * 正反辩论·逐轮记分（瘦身版）：把一轮的三维裁判（交锋 / 论据 / 收敛）压成**一行 inline pill**，再挂
 * 裁判理由与交锋点。三维取自主持人裁判真实字段 (real_clash / new_arguments / converged)，**不编造
 * 比分**。旧版是「带双方名标题行 + 3 列大网格」的独立卡、套在已嵌套的轮卡里 = 盒中盒（用户反馈
 * 的「重」），现降为一行信号——双方名已在下方发言格承载，不在记分处重复。
 */
function RoundScorecard({
  round,
  selectedClashIdx,
  onPickClash,
}: RoundVerdictProps) {
  const v = round.verdict;
  return (
    <>
      {v && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={verdictTogglePill(v.real_clash)}>
            {v.real_clash ? "有交锋" : "各说各话"}
          </span>
          <span className={verdictTogglePill(v.new_arguments)}>
            {v.new_arguments ? "有新论据" : "无新论据"}
          </span>
          <span
            className={
              v.converged ? statusPillInline.success : statusPillInline.muted
            }
          >
            {v.converged ? "已收敛" : "未收敛"}
          </span>
        </div>
      )}
      {v?.rationale && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          裁判：{v.rationale}
        </p>
      )}
      {round.clashes.length > 0 && (
        <ClashList
          clashes={round.clashes}
          selectedIdx={selectedClashIdx}
          onPick={onPickClash}
        />
      )}
    </>
  );
}

/**
 * 红队审查·风险看板：把一轮读成「本轮判定 (发现风险 / 已挖尽) + 方案方 + 风险点」。判定取自裁判
 * 字段；风险点复用交锋边 (红队针对性驳方案方 = 一条风险)，可点→展开发言并定位。方案方语义 key 由
 * roster 的 `is_subject` 标出 (进行中无 roster → 退化为不标方案方，不影响风险点列表)。
 */
function RoundRiskBoard({
  round,
  subjectKeys,
  selectedClashIdx,
  onPickClash,
}: RoundVerdictProps & { subjectKeys: ReadonlySet<string> }) {
  const v = round.verdict;
  const subject = round.sides.find((s) => subjectKeys.has(s.sideKey)) ?? null;
  return (
    <div className="mt-1.5 space-y-1.5">
      {v && <RiskVerdict verdict={v} />}
      {subject && (
        <p className="text-xs text-muted-foreground">
          方案方：
          <span className="font-medium" style={{ color: subject.colorVar }}>
            {subject.name}
          </span>
        </p>
      )}
      {v?.rationale && (
        <p className="text-xs text-muted-foreground">裁判：{v.rationale}</p>
      )}
      {round.clashes.length > 0 && (
        <ClashList
          clashes={round.clashes}
          selectedIdx={selectedClashIdx}
          onPick={onPickClash}
          title="风险点"
          icon={<ShieldAlert size={12} className={statusAccentText.warning} />}
        />
      )}
    </div>
  );
}

/** 风险看板的本轮判定条：收敛=风险已挖尽 (绿) / 有交锋=发现有效风险 (琥珀) / 否则无新风险 (灰)。 */
function RiskVerdict({ verdict }: { verdict: DebateVerdict }) {
  const { text, tone, Icon } = riskReadout(verdict);
  const shell =
    tone === "warning"
      ? surfaceSubtle.warning
      : tone === "success"
        ? "border-success/25 bg-success/5"
        : "border-border bg-muted/30";
  return (
    <div
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${shell}`}
    >
      <Icon size={14} className={`shrink-0 ${statusAccentText[tone]}`} />
      <span className="font-medium text-foreground">{text}</span>
    </div>
  );
}

/** 红队本轮判定的文案 + 语气 + 图标 (派生自裁判字段，不编造)。 */
function riskReadout(v: DebateVerdict): {
  text: string;
  tone: "success" | "warning" | "muted";
  Icon: typeof ShieldAlert;
} {
  if (v.converged) {
    return {
      text: "风险已挖尽 · 方案可加固",
      tone: "success",
      Icon: ShieldCheck,
    };
  }
  if (v.real_clash) {
    return {
      text: v.new_arguments ? "发现有效风险 · 有新论据" : "发现有效风险",
      tone: "warning",
      Icon: ShieldAlert,
    };
  }
  return { text: "本轮未发现新风险", tone: "muted", Icon: ShieldAlert };
}

/** 各方发言网格：2 方左右对开，多方自适应双列 (与 live / 收场同一布局)。`highlightKeys`
 *  非空时把命中当前选中交锋边的两方发言格标成 from/to (来源方驱动滚动定位)。 */
function SidesGrid({
  sides,
  execution,
  messageId,
  highlightKeys = null,
  highlightNonce = 0,
}: {
  sides: DebateSideModel[];
  execution: Execution;
  messageId: string;
  highlightKeys?: readonly [string, string] | null;
  highlightNonce?: number;
}) {
  return (
    <div
      className={`grid gap-3 ${
        sides.length === 2 ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2"
      }`}
    >
      {sides.map((side) => (
        <NarrativeSideCell
          key={side.key}
          side={side}
          execution={execution}
          messageId={messageId}
          highlightRole={clashRole(side.sideKey, highlightKeys)}
          highlightNonce={highlightNonce}
        />
      ))}
    </div>
  );
}

/** 本方在当前选中交锋边里的角色：来源方 from / 被驳方 to / 无关 null。空 sideKey (进行中当前轮
 *  尚无语义 key) 一律 null——该轮本就无交锋边。 */
function clashRole(
  sideKey: string,
  keys: readonly [string, string] | null,
): "from" | "to" | null {
  if (!keys || !sideKey) return null;
  if (sideKey === keys[0]) return "from";
  if (sideKey === keys[1]) return "to";
  return null;
}

/**
 * 一方的发言格：身份色标签栏头 (立场/视角名，点击钻取完整产出) + 渲染后的发言 markdown。
 * **身份 ≠ 状态**——身份走 {@link SideIdentity} 的 `colorVar`，运行状态仍走
 * {@link StatusDot}；live↔收场同一身份恒同色、同结构，可顺色追踪一方的论点链。
 */
function NarrativeSideCell({
  side,
  execution,
  messageId,
  highlightRole = null,
  highlightNonce = 0,
}: {
  side: DebateSideModel;
  execution: Execution;
  messageId: string;
  highlightRole?: "from" | "to" | null;
  highlightNonce?: number;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const cellRef = useRef<HTMLDivElement>(null);
  const run = side.run;
  const agent = run
    ? execution.agents.find((a) => a.id === run.agentId)
    : undefined;
  const output = agent ? agent.outputChunks.join("") : "";

  // 被点中的「来源方」滚到视野 (block:nearest 减少跳动)；两格都加品牌色环，标出这条交锋边连的是哪两格。
  useEffect(() => {
    if (highlightRole === "from" && highlightNonce) {
      cellRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [highlightRole, highlightNonce]);

  const header = (
    <span className="flex w-full items-center gap-1.5 text-left">
      {run && <StatusDot status={run.status} />}
      <SideIdentity
        name={side.name}
        colorVar={side.colorVar}
        model={side.model}
      />
      <span className="min-w-0 flex-1" />
      {run && (
        <ChevronRight
          size={13}
          className="shrink-0 text-muted-foreground/50 group-hover/cell:text-muted-foreground"
        />
      )}
    </span>
  );

  return (
    <div
      ref={cellRef}
      className={`min-w-0 overflow-hidden rounded-lg border border-l-2 border-border bg-card transition-shadow ${
        highlightRole
          ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
          : ""
      }`}
      style={{ borderLeftColor: side.colorVar }}
    >
      {run ? (
        // 只有关联到执行节点才可点钻取；用 tooltip 包一个【单】Button 子元素 (Radix Slot 约束)。
        <SimpleTooltip label="查看完整产出">
          <Button
            variant="ghost"
            onClick={() => showRunDetail(messageId, run.id, side.name)}
            className="group/cell h-auto w-full justify-start gap-1.5 rounded-none border-b border-border px-3 py-2 hover:bg-transparent"
          >
            {header}
          </Button>
        </SimpleTooltip>
      ) : (
        <div className="border-b border-border px-3 py-2">{header}</div>
      )}
      <div className="p-3">
        {!run ? (
          <p className="text-xs text-muted-foreground">
            {side.name}：发言未关联到执行节点。
          </p>
        ) : output ? (
          <div className="max-h-96 overflow-y-auto text-sm">
            <Markdown content={output} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{placeholder(run)}</p>
        )}
      </div>
    </div>
  );
}

/** 主持人对一轮的裁判 as pills: 交锋 / 新论据 / 收敛。`hideConverged` 让 L1 行独占 已收敛。 */
function VerdictBadges({
  verdict,
  hideConverged = false,
}: {
  verdict: DebateVerdict;
  hideConverged?: boolean;
}) {
  const pill = (on: boolean, onText: string, offText: string) => (
    <span className={verdictTogglePill(on)}>{on ? onText : offText}</span>
  );
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {pill(verdict.real_clash, "有交锋", "各说各话")}
      {pill(verdict.new_arguments, "有新论据", "无新论据")}
      {!hideConverged && verdict.converged && (
        <span className={statusPillInline.success}>已收敛</span>
      )}
    </div>
  );
}

/**
 * L3 交锋边「谁驳谁」(辩论编排设计.md §4.2)：把本轮裁判抽取的针对性反驳渲染成
 * `[来源方] → [被驳方]  要点` 的紧凑列表——双方名按身份色着色 (与发言格同源)，让「各说
 * 各话还是真接火」从一句裁判结论升级为可逐条读的交锋关系，无需用户脑补谁回应了谁。
 * 每条**可点**：点中即展开本轮发言、把对应两方发言格高亮 + 滚动定位 (引用连线 → 可直达导航)，
 * 选中条加中性底色回标。
 */
function ClashList({
  clashes,
  selectedIdx,
  onPick,
  title = "交锋点",
  icon,
}: {
  clashes: DebateClashView[];
  selectedIdx: number | null;
  onPick: (idx: number) => void;
  /** 列表小标题 + 图标：红队风险看板复用本组件、改标「风险点」(警示图标)。 */
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="mt-2.5">
      <h5 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon ?? <Swords size={12} />}
        {title}
      </h5>
      <ul className="mt-1.5 space-y-1">
        {clashes.map((c, i) => {
          const selected = i === selectedIdx;
          return (
            <li key={`${c.fromName}-${c.toName}-${i}`}>
              <button
                type="button"
                onClick={() => onPick(i)}
                className={`flex w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5 rounded-lg px-2 py-1 text-left text-sm transition-colors ${
                  selected ? "bg-accent" : "hover:bg-accent/60"
                }`}
                title="定位到双方发言"
              >
                <span className="inline-flex shrink-0 items-center gap-1">
                  <ClashName name={c.fromName} colorVar={c.fromColorVar} />
                  <ArrowRight size={12} className="text-muted-foreground" />
                  <ClashName name={c.toName} colorVar={c.toColorVar} />
                </span>
                <span className="min-w-0 flex-1 text-foreground">
                  {c.point}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 交锋边里的一方名：按身份色着色的纯文字 (比 {@link SideNamePill} 更轻，密集列表里不抢
 * 视觉)，与发言格同 `colorVar` → 顺色对上是哪一方。 */
function ClashName({ name, colorVar }: { name: string; colorVar: string }) {
  return (
    <span className="text-xs font-medium" style={{ color: colorVar }}>
      {name}
    </span>
  );
}

/** 发言出现前的占位文案。 */
function placeholder(run: RunNode): string {
  if (run.status === "running") return "正在生成…";
  if (run.status === "failed") return run.error ?? "该立场执行失败。";
  if (run.status === "cancelled") return "已停止。";
  return "（暂无输出）";
}

function StatusDot({ status }: { status: RunNode["status"] }) {
  return (
    <span className={`size-2 shrink-0 rounded-full ${runStatusDot[status]}`} />
  );
}
