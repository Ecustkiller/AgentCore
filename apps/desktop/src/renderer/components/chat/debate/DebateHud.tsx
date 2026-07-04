import { Button, IconButton, Textarea } from "@/components/ui";
import {
  countPillMuted,
  statusAccentText,
  statusPillInline,
  surfaceSubtle,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { notifyError } from "@/lib/toast";
import {
  type DebateRoundUserDecision,
  decideDebateRound,
} from "@/services/debate";
import { useDebateRoomStore } from "@/stores/debateRoom";
import {
  type DebateRoundDecision,
  type Execution,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import type { DebateBriefInfo, DebateSideInfo } from "@/types/events";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Gavel,
  Hand,
  Info,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Scale,
  ShieldAlert,
  Swords,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AskBubble, ModeratorAvatar } from "./DebateStream";
import { SideIdentity } from "./SideChip";
import {
  type DebateForm,
  type DebateModel,
  type DebateScoreView,
  debateFormBlurb,
  debateSideColorVar,
  stopLabel,
  tallyScores,
  toDebateModel,
} from "./model";
import {
  RISK_LEVELS,
  RISK_SEVERITY,
  buildRiskItems,
  rankOf,
  riskCounts,
} from "./severity";

/**
 * 辩论裁判台 HUD（裁决台 + 记分 + 掌舵）—— 统一右侧面板的**固定「裁判台」tab** 内容
 * （前端UX设计.md §4.3 · §十），与工作区（文件）/ run 详情 tab 平级互斥占满内容区。
 *
 * 数据单一来源：焦点辩论回合由 {@link import("../../graph/CanvasZoomedTurn").CanvasZoomedTurn} 经
 * {@link useDebateRoomStore} 发布（`target`），本模块据 `target.turnId` 从执行 store 投影出 execution +
 * {@link toDebateModel} 归一模型，其余（roster / 净分 / 待掌舵边界）全部 live 派生、无快照拷贝。
 * 流式/并排 与「结论↓」锚是**读法控件**，留在群聊流本体（{@link DebateStream} 的流内工具条），故本区
 * 不持有并排态、不跨树引 verdictRef——HUD 只管「判 / 记分 / 掌舵」，不与正文共享 UI 态（不重复实现）。
 */

/** 形态 → 中文名 + 图标（裁判台区头 + 折叠条）。 */
const FORM_META: Record<DebateForm, { label: string; Icon: typeof Scale }> = {
  debate: { label: "正反辩论", Icon: Scale },
  red_team: { label: "红队审查", Icon: Swords },
  roundtable: { label: "圆桌探讨", Icon: Users },
};

/** 阵营条的一方（收场取 roster，进行中从各轮发言并集去重补回；`model` 是该方驱动模型）。 */
function rosterChips(
  model: DebateModel,
): { sideKey: string; name: string; colorVar: string; model: string }[] {
  if (model.sides && model.sides.length > 0) {
    return model.sides.map((s) => ({
      sideKey: s.key,
      name: s.name,
      colorVar: debateSideColorVar(s.key, s.name),
      model: s.model ?? "",
    }));
  }
  const seen = new Set<string>();
  const out: {
    sideKey: string;
    name: string;
    colorVar: string;
    model: string;
  }[] = [];
  for (const r of model.rounds) {
    for (const s of r.sides) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({
        sideKey: s.sideKey,
        name: s.name,
        colorVar: s.colorVar,
        model: s.model,
      });
    }
  }
  return out;
}

/** Everything {@link DebateHudRegion} renders, derived live by {@link useDebateHud}. */
export interface DebateHudData {
  /** Whether a debate room is focused (canvas zoomed into 群聊) → the region may show. */
  show: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Focused debate turn's projected execution (source of steering decisions). */
  execution: Execution | null;
  /** Normalised debate model (roster / 净分 / leaning). */
  model: DebateModel | null;
  /** Focused turn id + steering round-trip context (from the bridge store). */
  turnId: string | null;
  conversationId: string | null;
  interactive: boolean;
  /** Pending steering boundaries (badge + auto-surface). */
  pending: number;
  /** When true the dock body is only 工作区 (no drilled detail tab) → region may grow past 72%. */
  expanded?: boolean;
}

/**
 * Drive the 辩论裁判台 region from stores (mirrors {@link
 * import("../../graph/CanvasDecisionPanel").useCommandRegion}). Reads the focused
 * debate room from {@link useDebateRoomStore}, projects its execution + model live,
 * and owns the auto-surface: entering a debate room opens the dock + expands the
 * region, and a fresh steering boundary re-opens + re-expands it, so the boss never
 * misses a 掌舵 call. Called unconditionally at the top of the side panel (before its
 * closed early-return) so the auto-surface can reveal a closed dock.
 */
export function useDebateHud(): DebateHudData {
  const target = useDebateRoomStore((s) => s.target);
  const collapsed = useDebateRoomStore((s) => s.collapsed);
  const setCollapsed = useDebateRoomStore((s) => s.setCollapsed);

  const turnId = target?.turnId ?? null;
  const execution = useMessageExecution(turnId);
  const model = useMemo(
    () => (execution ? toDebateModel(execution) : null),
    [execution],
  );
  const show = !!target && !!model;
  const pending =
    execution?.debateDecisions.filter((d) => d.status === "pending").length ??
    0;

  // Auto-surface on room entry: opening a debate room reveals the dock + expands the
  // region (the HUD is the debate's primary aux surface, mirroring the old always-on
  // rail) — but only when the focused turn changes, so a boss who deliberately closed
  // the dock mid-room isn't fought on every re-render.
  const prevTurn = useRef<string | null>(null);
  useEffect(() => {
    if (!show || !turnId) {
      prevTurn.current = null;
      return;
    }
    if (prevTurn.current !== turnId) {
      prevTurn.current = turnId;
      useSidePanelStore.getState().showDebateHudTab();
      setCollapsed(false);
    }
  }, [show, turnId, setCollapsed]);

  // Re-surface on a fresh steering boundary: a new 待你掌舵 pend re-opens + re-expands
  // the region and switches to the 工作区 tab so the HUD is visible even if the boss
  // was deep-reading a run tab (mirrors 指挥台 auto-surface).
  const prevPending = useRef(0);
  useEffect(() => {
    if (!show) {
      prevPending.current = 0;
      return;
    }
    if (pending > prevPending.current) {
      useSidePanelStore.getState().showDebateHudTab();
      setCollapsed(false);
    }
    prevPending.current = pending;
  }, [show, pending, setCollapsed]);

  return {
    show,
    collapsed,
    setCollapsed,
    execution,
    model,
    turnId,
    conversationId: target?.conversationId ?? null,
    interactive: target?.interactive ?? false,
    pending,
  };
}

/**
 * The 辩论裁判台 body rendered inside the side panel's fixed 「裁判台」 tab (前端UX设计.md
 * §4.3 · §十): collapsible header (形态 + 状态) + body (阵营 → 倾向 → 记分 → 掌舵).
 * Fills the tab content area (`expanded`); collapse folds to just the header.
 */
export function DebateHudRegion({
  collapsed,
  setCollapsed,
  execution,
  model,
  turnId,
  conversationId,
  interactive,
  pending,
  expanded = false,
}: DebateHudData) {
  if (!model || !execution || !turnId) return null;
  const { Icon, label } = FORM_META[model.form] ?? FORM_META.debate;
  const roster = rosterChips(model);
  const isVersus = model.form === "debate" && roster.length === 2;
  // 圆桌无单一胜负 → 无净分记分；其余累计逐轮记分（收场权威，live 为空 honest gap）。
  const netTally = model.form === "roundtable" ? [] : tallyScores(model.rounds);
  const leaning = model.settled ? model.brief?.leaning : undefined;
  const leadLabel =
    model.form === "red_team"
      ? "评定"
      : model.form === "roundtable"
        ? "综合"
        : "倾向";

  return (
    <section
      className={`flex shrink-0 flex-col border-b border-border bg-card ${
        expanded ? "min-h-0 flex-1" : "max-h-[72%]"
      }`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
        <Icon size={15} className={`shrink-0 ${statusAccentText.primary}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {label}
          {pending > 0 && (
            <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary">
              {pending}
            </span>
          )}
        </span>
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
        <IconButton
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "展开裁判台" : "折叠裁判台"}
          aria-expanded={!collapsed}
          title={collapsed ? "展开裁判台" : "折叠裁判台"}
        >
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </IconButton>
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {/* 阵营对垒（谁是哪个模型）：正反 2 方竖排 + VS 中缝，多方平铺。 */}
          {roster.length > 0 && (
            <div className="space-y-1.5">
              {roster.map((r, i) => (
                <div key={r.sideKey || r.name}>
                  {isVersus && i === 1 && (
                    <div className="py-0.5 text-xs font-bold text-muted-foreground">
                      VS
                    </div>
                  )}
                  <SideIdentity
                    name={r.name}
                    colorVar={r.colorVar}
                    model={r.model}
                  />
                </div>
              ))}
            </div>
          )}
          {/* P2 分形态几何：裁判台中间槽按形态出「一眼态」——正反=记分板、红队=风险盘口、圆桌=观点光谱；
              仅收场态有结构化 brief（live 空 = honest gap，与记分同规矩）。完整看板/光谱仍在流末终审。 */}
          <FormGlance model={model} netTally={netTally} />
          {/* 一句话倾向 / 评定 / 综合（收场）——完整裁决仍在中区流末终审，不前置剧透。 */}
          {leaning && (
            <div className="flex items-start gap-1.5 border-t border-border/60 pt-2.5 text-sm text-foreground">
              <Scale
                size={14}
                className={`mt-0.5 shrink-0 ${statusAccentText.primary}`}
              />
              <span>
                <span className="font-medium">{leadLabel}：</span>
                {leaning}
              </span>
            </div>
          )}
          {!model.settled && (
            <SteeringSection
              key={turnId}
              model={model}
              execution={execution}
              conversationId={conversationId}
              interactive={interactive}
            />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 裁判台形态槽（P2 分形态几何）——按辩论形态在阵营条与倾向/掌舵之间插入专属的「一眼态」：
 *  - 正反：累计净分记分板（{@link RailScores}）；
 *  - 红队：风险盘口（高危/中危/低危计数 + 最尖锐几条，{@link RiskGlance}）；
 *  - 圆桌：观点光谱（各视角一行核心主张，{@link SpectrumGlance}）。
 * 结构化数据仅收场 brief 权威；进行中各形态 honest gap（不杜撰）。
 */
function FormGlance({
  model,
  netTally,
}: {
  model: DebateModel;
  netTally: DebateScoreView[];
}) {
  if (!model.settled || !model.brief) {
    return <FormGlancePending form={model.form} />;
  }
  if (model.form === "red_team" && model.sides) {
    return <RiskGlance brief={model.brief} sides={model.sides} />;
  }
  if (model.form === "roundtable" && model.sides) {
    return <SpectrumGlance brief={model.brief} sides={model.sides} />;
  }
  if (netTally.length > 0) {
    return <RailScores tally={netTally} />;
  }
  return null;
}

/** 进行中各形态的 honest gap——裁判台中间槽占位，说明收场后才会出现形态专属一眼态。 */
function FormGlancePending({ form }: { form: DebateForm }) {
  const hint =
    form === "red_team"
      ? "风险盘口 · 收场后呈现"
      : form === "roundtable"
        ? "观点光谱 · 收场后呈现"
        : "记分 · 逐轮交锋后累计";
  return (
    <div className="rounded-xl border border-dashed border-border/80 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {hint}
    </div>
  );
}

/**
 * 红队风险盘口（裁判台紧凑版）——与流末终审 {@link import("./Brief").RiskBoard} 同数同序：
 * 盘口计数（高→中→低）+ 由危到轻最多 3 条最尖锐风险（line-clamp），完整清单仍在流末。
 */
function RiskGlance({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const risks = buildRiskItems(sides, brief);
  if (risks.length === 0) return null;
  const counts = riskCounts(risks);
  const top = [...risks]
    .sort((a, b) => rankOf(a.level) - rankOf(b.level))
    .slice(0, 3);
  const shownLevels = RISK_LEVELS.filter((l) => counts[l] > 0);
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <ShieldAlert size={13} className={statusAccentText.destructive} />
          风险盘口
        </div>
        {shownLevels.length > 0 && (
          <div className="flex items-center gap-1">
            {shownLevels.map((l) => (
              <span key={l} className={RISK_SEVERITY[l].pill}>
                {RISK_SEVERITY[l].label} {counts[l]}
              </span>
            ))}
          </div>
        )}
      </div>
      <ul className="space-y-2">
        {top.map((r) => {
          const meta = r.level ? RISK_SEVERITY[r.level] : null;
          return (
            <li
              key={r.side.key}
              className={meta?.surface ?? "border-l-2 border-border pl-2"}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate text-xs font-medium"
                  style={{
                    color: debateSideColorVar(r.side.key, r.side.name),
                  }}
                >
                  {r.side.name}
                </span>
                {meta && <span className={meta.pill}>{meta.label}</span>}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-foreground">
                {r.text}
              </p>
            </li>
          );
        })}
      </ul>
      {risks.length > top.length && (
        <p className="mt-2 text-xs text-muted-foreground">
          另有 {risks.length - top.length} 条 · 见流末终审
        </p>
      )}
    </div>
  );
}

/**
 * 圆桌观点光谱（裁判台紧凑版）——各视角一行核心主张（`strongest_points`），与流末
 * {@link import("./Brief").RoundtableSpectrum} 同字段；完整光谱 + 综合观察仍在流末。
 */
function SpectrumGlance({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const points = sides
    .map((s) => ({
      side: s,
      text: brief.strongest_points[s.key],
    }))
    .filter((p): p is { side: DebateSideInfo; text: string } =>
      Boolean(p.text),
    );
  if (points.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Users size={13} className={statusAccentText.primary} />
        观点光谱
      </div>
      <ul className="space-y-2">
        {points.map((p) => (
          <li
            key={p.side.key}
            className="border-l-2 pl-2"
            style={{
              borderLeftColor: debateSideColorVar(p.side.key, p.side.name),
            }}
          >
            <SideIdentity
              name={p.side.name}
              colorVar={debateSideColorVar(p.side.key, p.side.name)}
              model={p.side.model}
            />
            <p className="mt-0.5 line-clamp-2 text-xs text-foreground">
              {p.text}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 右轨记分板（记分裁判 P2 · 裁判台常驻）：逐轮记分累计的每方净分比分条（身份色），一眼势均力敌 /
 *  谁占优。与流末折叠的「记分总览」同数不同处（此处常驻侧栏、那里在终审内）。空则上层不渲染。 */
function RailScores({ tally }: { tally: DebateScoreView[] }) {
  const max = Math.max(1, ...tally.map((s) => s.total));
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
        <ClipboardList size={13} className={statusAccentText.primary} />
        记分
      </div>
      <div className="space-y-1.5">
        {tally.map((s) => (
          <div key={s.sideKey} className="flex items-center gap-2">
            <span
              className="w-16 shrink-0 truncate text-xs font-medium"
              style={{ color: s.colorVar }}
            >
              {s.name}
            </span>
            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(4, (s.total / max) * 100)}%`,
                  backgroundColor: s.colorVar,
                }}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">
              {s.total}
            </span>
          </div>
        ))}
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
 * 掌舵段（进行中·裁判台内）—— 把「请你掌舵」收进裁判台：先回显本会话已发出的追问（乐观件），再在
 * 主持人挂起的边界出**掌舵行动条**（{@link SteeringBar}）。无挂起边界（非交互辩论 / 正辩到一半）→
 * 不出行动条；挂起但本回合已重载（interactive=false，决策卡 transport-only 已失）→ 出只读提示。
 * 乐观追问件（{@link SentAsk}）为本段自持态（收场切走由流内权威 InterjectionBubble 承载，不重复）。
 */
function SteeringSection({
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
