import { Button } from "@/components/ui";
import {
  countPillMuted,
  statusAccentText,
  statusPillInline,
  surfaceMutedPanel,
  textLinkPrimary,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Gavel, Scale, Swords, Target, Users } from "lucide-react";
import { useRef } from "react";
import { BriefCard, RoundtableSpectrum } from "./debate/Brief";
import { RoundList } from "./debate/Narrative";
import {
  type DebateForm,
  type DebateModel,
  toDebateModel,
} from "./debate/model";

/**
 * 辩论双产物面 (辩论编排设计.md「双产物」) —— 决策简报 + 交锋叙事线，渲染在**画布放大态**的
 * 「交锋叙事」标签页 ({@link import("../graph/CanvasZoomedTurn").CanvasZoomedTurn})。聊天视图
 * 不再内联辩论卡：辩论是「过程」，归画布 (一份数据两种渲染，前端UX设计.md §四/§六)，入口是
 * 协作图状态条的「在画布打开」。
 *
 * {@link toDebateModel} 把「进行中」(transport `debateRounds` + 辩手 run 树) 与「收场」
 * (权威 `debate_result`) 归一成同一个 {@link DebateModel}：切到交锋页即据此渲染——简报与辩题
 * 在收场处**淡入**，叙事是一条贯穿 live→收场 的统一轮次列表 (后端把进行中逐轮与收场逐轮设计成
 * **同构孪生**，辩论编排设计.md §7.4)。各方发言全文点角色钻右侧详情面板。
 *
 * 无外层折叠卡壳/卡头——放大态自带顶栏与「交锋叙事 ↔ 协作图」切换，本组件只出内容。
 */
export function DebateBody({
  execution,
  messageId,
}: {
  execution: Execution;
  messageId: string;
}) {
  const model = toDebateModel(execution);
  if (!model) return null;
  return (
    <DebateBodyInner
      model={model}
      execution={execution}
      messageId={messageId}
    />
  );
}

const FORM_META: Record<DebateForm, { label: string; Icon: typeof Scale }> = {
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

function stopLabel(reason: string | null): string {
  if (!reason) return "";
  return STOP_LABELS[reason] ?? reason;
}

/**
 * 产物面主体：形态行 (图标 + 形态名 + 进行中/收场原因 pill) + 辩题头 + 决策简报 (收场淡入)
 * + 交锋叙事线。`narrative_first` 调简报与叙事顺序；本实例若**亲眼看着** live→收场 (曾渲染过
 * 进行中) 则简报恒追加在叙事下方，不把正读的轮顶下去 (设计 §4.3)。
 */
function DebateBodyInner({
  model,
  execution,
  messageId,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
}) {
  const { label: formLabel, Icon } = FORM_META[model.form] ?? FORM_META.debate;

  const wasLive = useRef(!model.settled);
  if (!model.settled) wasLive.current = true;
  const narrativeFirst =
    model.settled && wasLive.current ? true : model.narrativeFirst;

  // 辩题已在下方 DebateTopicHeader 展示 (进行中 motion = 首轮焦点占位)；把它传给叙事线，
  // 让与辩题同文的轮焦点显示为「本轮交锋」，不再辩题/第 1 轮上下重复。
  const topicMotion = model.motion ?? model.rounds[0]?.focus ?? "";
  const narrative = (
    <RoundList
      rounds={model.rounds}
      execution={execution}
      messageId={messageId}
      topicMotion={topicMotion}
      form={model.form}
      sides={model.sides}
    />
  );
  // 简报/光谱仅收场存在 → 首次挂载时 task-card-enter 淡入 (此块新挂)。圆桌把「观点光谱」提到
  // 叙事**之前**的英雄区 (结论先行 · glanceable)；正反/红队仍由 BriefCard 的裁决 hero 承载。
  const spectrum =
    model.form === "roundtable" && model.brief && model.sides ? (
      <div className="animate-task-card-enter">
        <RoundtableSpectrum brief={model.brief} sides={model.sides} />
      </div>
    ) : null;
  const brief =
    model.brief && model.sides ? (
      <div className="animate-task-card-enter">
        <BriefCard brief={model.brief} sides={model.sides} form={model.form} />
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Icon size={15} className={`shrink-0 ${statusAccentText.primary}`} />
        <span className="flex-1 text-sm font-medium text-foreground">
          {formLabel}
        </span>
        {model.settled ? (
          <SimpleTooltip label="辩论收场原因">
            <span className={countPillMuted}>
              {stopLabel(model.stopReason)}
            </span>
          </SimpleTooltip>
        ) : (
          <span className={statusPillInline.primary}>进行中</span>
        )}
      </div>
      <DebateTopicHeader
        model={model}
        execution={execution}
        messageId={messageId}
      />
      {spectrum}
      {narrativeFirst ? (
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
  );
}

/**
 * 辩题 + 主持人 (the debate's framing)。`motion` 收场才权威；进行中用**首轮焦点**占位 (用户
 * 拍板)，收场再换成真辩题——同一容器内文本替换，不重挂。主持人裁决链仅收场可钻取
 * (`moderatorRunId` 收场才有)。两者都无 → 进行中尚无焦点，整块略去。
 */
function DebateTopicHeader({
  model,
  execution,
  messageId,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const motion = model.motion ?? model.rounds[0]?.focus ?? "";
  const moderatorRun = model.moderatorRunId
    ? execution.runs.find((r) => r.id === model.moderatorRunId)
    : undefined;
  if (!motion && !moderatorRun) return null;

  return (
    <div className={`${surfaceMutedPanel} p-3`}>
      {motion && (
        <div className="flex items-start gap-2">
          <Target
            size={14}
            className={`mt-0.5 shrink-0 ${statusAccentText.primary}`}
          />
          <div className="min-w-0 flex-1">
            <span className="text-xs text-muted-foreground">辩题</span>
            <p className="mt-0.5 text-sm font-medium text-foreground">
              {motion}
            </p>
          </div>
        </div>
      )}
      {moderatorRun && (
        <Button
          variant="ghost"
          onClick={() => showRunDetail(messageId, moderatorRun.id, "主持人")}
          className={`mt-2 h-auto px-0 py-0 ${textLinkPrimary} hover:bg-transparent`}
          icon={<Gavel size={12} />}
        >
          主持人裁决过程
        </Button>
      )}
    </div>
  );
}
