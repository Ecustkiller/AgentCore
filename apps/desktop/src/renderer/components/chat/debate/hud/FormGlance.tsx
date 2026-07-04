import { statusAccentText } from "@/components/ui/tone-presets";
import type { DebateSideInfo } from "@/types/events";
import type { DebateBriefInfo } from "@/types/events";
import { ClipboardList, ShieldAlert, Users } from "lucide-react";
import { SideIdentity } from "../SideChip";
import {
  type DebateForm,
  type DebateModel,
  type DebateScoreView,
  debateSideColorVar,
} from "../model";
import {
  RISK_LEVELS,
  RISK_SEVERITY,
  buildRiskItems,
  rankOf,
  riskCounts,
} from "../severity";

/**
 * 裁判台形态槽（P2 分形态几何）——按辩论形态在阵营条与倾向/掌舵之间插入专属的「一眼态」：
 *  - 正反：累计净分记分板（{@link RailScores}）；
 *  - 红队：风险盘口（高危/中危/低危计数 + 最尖锐几条，{@link RiskGlance}）；
 *  - 圆桌：观点光谱（各视角一行核心主张，{@link SpectrumGlance}）。
 * 结构化数据仅收场 brief 权威；进行中各形态 honest gap（不杜撰）。
 */
export function FormGlance({
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
export function RiskGlance({
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
export function SpectrumGlance({
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
export function RailScores({ tally }: { tally: DebateScoreView[] }) {
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
