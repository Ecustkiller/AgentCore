import { IconButton } from "@/components/ui";
import {
  countPillMuted,
  statusAccentText,
  statusPillInline,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  ChevronDown,
  ChevronUp,
  Info,
  Scale,
  Swords,
  Users,
} from "lucide-react";
import { SideIdentity } from "../SideChip";
import {
  type DebateForm,
  type DebateModel,
  debateFormBlurb,
  debateSideColorVar,
  stopLabel,
  tallyScores,
} from "../model";
import { FormGlance } from "./FormGlance";
import { SteeringSection } from "./SteeringBar";
import type { DebateHudData } from "./useDebateHud";

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
