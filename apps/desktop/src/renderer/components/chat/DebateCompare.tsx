import { Markdown } from "@/components/chat/Markdown";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type DebateRound,
  type Execution,
  type RunNode,
  STANCE_META,
  type Stance,
  debateGroups,
  debateLiveRounds,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import type {
  DebateBriefInfo,
  DebateNarrativeRound,
  DebateResultPayload,
  DebateRoundInfo,
  DebateSideInfo,
} from "@/types/events";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns2,
  HelpCircle,
  Lightbulb,
  MessagesSquare,
  Scale,
  Swords,
  Target,
  Users,
} from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * 辩论回合的产物卡 (辩论编排设计.md「双产物」), embedded below the team graph.
 *
 * Two paths off the same per-message {@link Execution} (no second source of truth):
 *  1. 收场后 (`execution.debate` 在手): the redesigned 双产物 view — a 决策简报 card
 *     (the conclusion: 倾向/置信/争点/最强论点/分歧/建议/待解) over a 三层叙事线 (the
 *     process: 逐轮 焦点 → 裁判/小结 → 各方发言全文). `narrative_first` flips their
 *     order so an exploratory roundtable leads with the process, a decision debate
 *     with the conclusion.
 *  2. 进行中 / 旧 journal (无 `debate_result`): falls back to a live view so the user
 *     watches each side argue in real time while the moderator is still judging — there
 *     is no conclusion to show yet. 2方正反走 stance 左右并排 ({@link LiveDebateGroups})；
 *     多方（圆桌 / 红队，无 stance）走逐轮多方 ({@link LiveMultiSideDebate})。
 */
export function DebateCompare({
  execution,
  messageId,
}: {
  execution: Execution;
  messageId: string;
}) {
  if (execution.debate) {
    return (
      <DebateProducts
        debate={execution.debate}
        execution={execution}
        messageId={messageId}
      />
    );
  }
  // 2方正反有 stance → 左右并排；圆桌 / 红队无 stance → 逐轮多方（否则进行中内联空白）。
  if (debateGroups(execution).length > 0) {
    return <LiveDebateGroups execution={execution} messageId={messageId} />;
  }
  return <LiveMultiSideDebate execution={execution} messageId={messageId} />;
}

const FORM_META: Record<
  DebateResultPayload["form"],
  { label: string; Icon: typeof Scale }
> = {
  debate: { label: "正反辩论", Icon: Scale },
  red_team: { label: "红队审查", Icon: Swords },
  roundtable: { label: "圆桌探讨", Icon: Users },
};

/** 辩论收场原因 → 中文 (镜像后端 STOP_REASONS / runtime/debate/types.py _stop_label).
 * Unknown reasons render raw. */
const STOP_LABELS: Record<string, string> = {
  converged: "已收敛",
  focus_clarified: "已澄清为价值之争",
  red_team_exhausted: "风险已挖尽",
  max_rounds: "达轮次上限",
  all_failed: "发言失败提前终止",
};

/** 双产物主视图: 决策简报 + 三层叙事线, in a collapsible card under the graph. */
function DebateProducts({
  debate,
  execution,
  messageId,
}: {
  debate: DebateResultPayload;
  execution: Execution;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const { label: formLabel, Icon } = FORM_META[debate.form] ?? FORM_META.debate;
  const stopLabel = STOP_LABELS[debate.stop_reason] ?? debate.stop_reason;

  const brief = <BriefCard brief={debate.brief} sides={debate.sides} />;
  const narrative = (
    <NarrativeLine
      debate={debate}
      execution={execution}
      messageId={messageId}
    />
  );

  return (
    <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <Icon size={15} className="shrink-0 text-info" />
        <span className="flex-1 text-sm font-medium text-foreground">
          辩论结论
        </span>
        <span className="shrink-0 rounded-full bg-info/10 px-1.5 py-0.5 text-xs font-medium text-info">
          {formLabel}
        </span>
        <SimpleTooltip label="辩论收场原因">
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {stopLabel}
          </span>
        </SimpleTooltip>
        {expanded ? (
          <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border p-4">
          {debate.narrative_first ? (
            <>
              {narrative}
              {brief}
            </>
          ) : (
            <>
              {brief}
              {narrative}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 置信度 → label + 配色 token (a classification, not a run-status color). */
const CONFIDENCE_META: Record<string, { label: string; cls: string }> = {
  high: { label: "高", cls: "bg-success/10 text-success" },
  medium: { label: "中", cls: "bg-warning/10 text-warning" },
  low: { label: "低", cls: "bg-muted text-muted-foreground" },
};

/**
 * 决策简报 (结论卡): the moderator's verdict at a glance — 倾向 + 置信 up top, then
 * 关键争点, 各方最强论点 (one cell per side, keyed off `strongest_points[side.key]`),
 * 事实/价值分歧, 建议, 待解问题. Sections with no content are omitted (honest gaps).
 */
function BriefCard({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const conf = CONFIDENCE_META[brief.confidence] ?? CONFIDENCE_META.medium;
  return (
    <section className="space-y-3 rounded-lg border border-info/30 bg-info/5 p-4">
      <div className="flex items-start gap-2">
        <Scale size={16} className="mt-0.5 shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">结论倾向</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${conf.cls}`}
            >
              置信 {conf.label}
            </span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-foreground">
            {brief.leaning}
          </p>
        </div>
      </div>

      <BriefField icon={<Target size={14} />} label="关键争点">
        <p className="text-sm text-foreground">{brief.crux}</p>
      </BriefField>

      <div>
        <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
          各方最强论点
        </h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {sides.map((s) => (
            <div
              key={s.key}
              className="rounded-lg border border-border bg-card p-2.5"
            >
              <span className="text-xs font-medium text-info">{s.name}</span>
              <p className="mt-1 text-sm text-foreground">
                {brief.strongest_points[s.key] ?? "—"}
              </p>
            </div>
          ))}
        </div>
      </div>

      {brief.factual_disputes.length > 0 && (
        <BriefList label="事实分歧" items={brief.factual_disputes} />
      )}
      {brief.value_disputes.length > 0 && (
        <BriefList label="价值分歧" items={brief.value_disputes} />
      )}

      <BriefField
        icon={<Lightbulb size={14} className="text-warning" />}
        label="建议"
      >
        <p className="text-sm text-foreground">{brief.recommendation}</p>
      </BriefField>

      {brief.open_questions.length > 0 && (
        <BriefList
          icon={<HelpCircle size={14} />}
          label="待解问题"
          items={brief.open_questions}
        />
      )}
    </section>
  );
}

/** A labelled section in the brief card. */
function BriefField({
  icon,
  label,
  children,
}: {
  icon?: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </h4>
      {children}
    </div>
  );
}

/** A labelled bullet list in the brief card (分歧 / 待解问题). */
function BriefList({
  icon,
  label,
  items,
}: {
  icon?: ReactNode;
  label: string;
  items: string[];
}) {
  return (
    <BriefField icon={icon} label={label}>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it} className="flex gap-1.5 text-sm text-foreground">
            <span className="shrink-0 text-muted-foreground">·</span>
            <span className="min-w-0 flex-1">{it}</span>
          </li>
        ))}
      </ul>
    </BriefField>
  );
}

/**
 * 交锋叙事线 (the process): one block per round. Each block is the three layers —
 * L1 焦点 + 裁判徽章, L2 主持人小结 + 裁判理由, L3 各方发言全文 (collapsed by default,
 * resolved from `side.run_id` → the debater node so the verbatim case lives once).
 */
function NarrativeLine({
  debate,
  execution,
  messageId,
}: {
  debate: DebateResultPayload;
  execution: Execution;
  messageId: string;
}) {
  if (debate.rounds.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessagesSquare size={14} />
        交锋叙事线 · {debate.rounds.length} 轮
      </h3>
      <ol className="space-y-2">
        {debate.rounds.map((round) => (
          <RoundBlock
            key={round.round_no}
            round={round}
            execution={execution}
            messageId={messageId}
          />
        ))}
      </ol>
    </div>
  );
}

/** One round of the narrative line (three layers, L3 lazily expanded). */
function RoundBlock({
  round,
  execution,
  messageId,
}: {
  round: DebateRoundInfo;
  execution: Execution;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-border bg-muted/20">
      <div className="p-3">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            第 {round.round_no} 轮
          </span>
          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
            {round.focus}
          </span>
        </div>

        <VerdictBadges verdict={round.verdict} />

        {round.summary && (
          <p className="mt-2 text-sm text-foreground">{round.summary}</p>
        )}
        {round.verdict.rationale && (
          <p className="mt-1 text-xs text-muted-foreground">
            裁判：{round.verdict.rationale}
          </p>
        )}

        {round.sides.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-info hover:underline"
          >
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {open ? "收起各方发言" : `展开各方发言（${round.sides.length}）`}
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          {round.sides.map((side) => {
            const run = execution.runs.find((r) => r.id === side.run_id);
            return run ? (
              <OutputCell
                key={side.run_id}
                run={run}
                execution={execution}
                messageId={messageId}
              />
            ) : (
              <p key={side.run_id} className="text-xs text-muted-foreground">
                {side.name}：发言未关联到执行节点。
              </p>
            );
          })}
        </div>
      )}
    </li>
  );
}

/** 主持人对一轮的裁判 (收敛判定) as small pills: 交锋 / 新论据 / 收敛. */
function VerdictBadges({ verdict }: { verdict: DebateRoundInfo["verdict"] }) {
  const pill = (on: boolean, onText: string, offText: string) => (
    <span
      className={`rounded-full px-1.5 py-0.5 text-xs ${
        on ? "bg-info/10 text-info" : "bg-muted text-muted-foreground"
      }`}
    >
      {on ? onText : offText}
    </span>
  );
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {pill(verdict.real_clash, "有交锋", "各说各话")}
      {pill(verdict.new_arguments, "有新论据", "无新论据")}
      {verdict.converged && (
        <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-xs text-success">
          已收敛
        </span>
      )}
    </div>
  );
}

/**
 * 兜底视图: 辩论/审查「左右并排对比」(前端UX设计.md §四④, 落点 B).
 *
 * Used while the debate is still running (no 收场 产物 yet) or for an old journal
 * that predates `debate_result`: each comparison group's 正方 / 反方 worker outputs
 * sit side by side, so the user weighs the opposing live cases at a glance. A turn
 * may carry several opposing pairs (multi-dimension review) — one row per `group`.
 */
function LiveDebateGroups({
  execution,
  messageId,
}: {
  execution: Execution;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const groups = debateGroups(execution);
  if (groups.length === 0) return null;

  return (
    <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <Columns2 size={15} className="shrink-0 text-info" />
        <span className="flex-1 text-sm font-medium text-foreground">
          辩论对比
        </span>
        {expanded ? (
          <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border p-4">
          {groups.map((group) => {
            // 真·多轮辩论 (前端UX设计.md §四): a group whose runs carry round tags lays
            // out 逐轮 (each turn its own 正/反 row); a plain single-round debate (all
            // round 0) keeps the flat 正方 vs 反方 grid — same projection, two layouts.
            const isMultiRound = group.rounds.some((r) => r.round > 0);
            return isMultiRound ? (
              <div key={group.key} className="space-y-3">
                {group.rounds.map((round) => (
                  <RoundRow
                    key={round.round}
                    round={round}
                    execution={execution}
                    messageId={messageId}
                  />
                ))}
              </div>
            ) : (
              <div key={group.key} className="grid grid-cols-2 gap-3">
                <SideColumn
                  side="pro"
                  runs={group.pro}
                  execution={execution}
                  messageId={messageId}
                />
                <SideColumn
                  side="con"
                  runs={group.con}
                  execution={execution}
                  messageId={messageId}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 多方辩论 (圆桌 / 红队 / 3+方) 进行中的逐轮 live 视图 —— {@link LiveDebateGroups} 的
 * stance 左右并排只覆盖 2 方正反；圆桌 / 红队无 stance，过去进行中内联是空白、只能逐个点
 * 团队图节点看。
 *
 * 每轮合并两路实时信号，按轮号对齐：① 主持人逐轮叙事 {@link Execution.debateRounds}
 * （`debate_round_started` 发言前先报焦点 → `debate_round` 裁判后补小结/裁判）；② 各方发言
 * {@link debateLiveRounds}（续写 revision == 轮次重建）。于是一轮呈现为「焦点 → 各方发言 →
 * 小结 + 裁判」，进行中就能内联扫到全场 + 主持人的逐轮编排。收场后由 {@link DebateProducts}
 * 的全量叙事线接管。
 */
function LiveMultiSideDebate({
  execution,
  messageId,
}: {
  execution: Execution;
  messageId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const speechRounds = debateLiveRounds(execution);
  const narrative = execution.debateRounds;
  // 取发言轮号 ∪ 叙事轮号：叙事可能先于发言到（焦点先亮），发言也可能先到（事件未达）。
  const roundNos = Array.from(
    new Set([
      ...speechRounds.map((r) => r.round),
      ...narrative.map((r) => r.round_no),
    ]),
  ).sort((a, b) => a - b);
  if (roundNos.length === 0) return null;

  return (
    <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <Users size={15} className="shrink-0 text-info" />
        <span className="flex-1 text-sm font-medium text-foreground">
          多方观点
        </span>
        {expanded ? (
          <ChevronUp size={15} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border p-4">
          {roundNos.map((roundNo) => {
            const runs =
              speechRounds.find((r) => r.round === roundNo)?.runs ?? [];
            const info =
              narrative.find((r) => r.round_no === roundNo) ?? null;
            return (
              <div key={roundNo} className="space-y-1.5">
                {/* 焦点头：主持人发言前先报本轮焦点（无叙事则裸轮号）。 */}
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    第 {roundNo} 轮
                  </span>
                  {info?.focus && (
                    <span className="text-xs font-medium text-foreground">
                      {info.focus}
                    </span>
                  )}
                </div>
                {/* 各方发言（revision 重建）。 */}
                {runs.length > 0 && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {runs.map((run) => (
                      <div
                        key={run.id}
                        className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/30 p-3"
                      >
                        <OutputCell
                          run={run}
                          execution={execution}
                          messageId={messageId}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {/* 主持人小结 + 裁判：发言后补上（verdict=null = 该轮仍在进行）。 */}
                {info && (info.summary || info.verdict) && (
                  <div className="rounded-lg border border-border bg-muted/20 p-2.5">
                    {info.summary && (
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                        {info.summary}
                      </p>
                    )}
                    {info.verdict && <VerdictBadges verdict={info.verdict} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One turn of a 真·多轮辩论 (前端UX设计.md §四): a「第 N 轮」label above that round's
 * 正/反 columns, so the user reads the exchange turn by turn (第 k 轮的一方 rebuts the
 * other's 第 k-1 轮, wired by the CEO via cross-round depends_on). */
function RoundRow({
  round,
  execution,
  messageId,
}: {
  round: DebateRound;
  execution: Execution;
  messageId: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
        第 {round.round} 轮
      </span>
      <div className="grid grid-cols-2 gap-3">
        <SideColumn
          side="pro"
          runs={round.pro}
          execution={execution}
          messageId={messageId}
        />
        <SideColumn
          side="con"
          runs={round.con}
          execution={execution}
          messageId={messageId}
        />
      </div>
    </div>
  );
}

/** One side of a comparison group: a labelled column stacking that side's worker
 * output(s). Empty when the CEO tagged only one side (honest gap, not a crash). */
function SideColumn({
  side,
  runs,
  execution,
  messageId,
}: {
  side: Stance;
  runs: RunNode[];
  execution: Execution;
  messageId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/30">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="rounded-full bg-info/10 px-1.5 py-0.5 text-xs font-medium text-info">
          {STANCE_META[side].label}
        </span>
      </div>
      <div className="space-y-3 p-3">
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            （无{STANCE_META[side].label}产出）
          </p>
        ) : (
          runs.map((run) => (
            <OutputCell
              key={run.id}
              run={run}
              execution={execution}
              messageId={messageId}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** A single worker's output: a clickable role header (drills into the full run
 * detail) above the rendered markdown, with a graceful placeholder while the run is
 * still streaming / failed / silent. Output is height-capped so a long case does
 * not blow the card up; the full text lives in the detail panel. */
function OutputCell({
  run,
  execution,
  messageId,
}: {
  run: RunNode;
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const agent = execution.agents.find((a) => a.id === run.agentId);
  const role = agent?.role ?? run.agentId;
  const output = agent ? agent.outputChunks.join("") : "";

  return (
    <div className="min-w-0">
      <SimpleTooltip label="查看完整产出">
        <button
          type="button"
          onClick={() => showRunDetail(messageId, run.id, role)}
          className="group/cell mb-1.5 flex w-full items-center gap-1.5 text-left"
        >
          <StatusDot status={run.status} />
          <span className="flex-1 truncate text-xs font-medium text-foreground">
            {role}
          </span>
          <ChevronRight
            size={13}
            className="shrink-0 text-muted-foreground/50 group-hover/cell:text-muted-foreground"
          />
        </button>
      </SimpleTooltip>
      {output ? (
        <div className="max-h-96 overflow-y-auto text-sm">
          <Markdown content={output} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{placeholder(run)}</p>
      )}
    </div>
  );
}

/** What to show in a side cell before there is output text. */
function placeholder(run: RunNode): string {
  if (run.status === "running") return "正在生成…";
  if (run.status === "failed") return run.error ?? "该立场执行失败。";
  if (run.status === "cancelled") return "已停止。";
  return "（暂无输出）";
}

const STATUS_DOT: Record<RunNode["status"], string> = {
  pending: "bg-muted-foreground/30",
  ready: "bg-muted-foreground/30",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/30",
};

function StatusDot({ status }: { status: RunNode["status"] }) {
  return (
    <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
  );
}
