import {
  brandPanelPrimary,
  confidenceLabel,
  confidencePill,
  statusAccentText,
  surfaceMutedPanel,
  surfaceSubtle,
} from "@/components/ui/tone-presets";
import { agentColorVar } from "@/lib/agentIdentity";
import type { DebateBriefInfo, DebateSideInfo } from "@/types/events";
import {
  HelpCircle,
  Lightbulb,
  MessagesSquare,
  Scale,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  Target,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type { DebateForm } from "./model";

/**
 * 决策简报 (结论卡) — 按形态分派，每形态以其**产物侧重**先行 (辩论编排设计.md §三)：
 *  - **正反辩论**：裁决先行 (倾向 + 置信)。
 *  - **红队审查**：风险清单 + 加固建议先行。
 *  - **圆桌探讨**：观点光谱已提到叙事**之前**的英雄区 ({@link RoundtableSpectrum})，本卡只剩
 *    叙事之后的简报小结 (共同焦点 + 分歧 + 待解)；无单一裁决、不挂置信表。
 * 三套共用同一组 brief 字段与子部件，仅骨架不同；无内容的区块一律省略 (honest gaps)。
 */
export function BriefCard({
  brief,
  sides,
  form,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
  form: DebateForm;
}) {
  if (form === "red_team") return <RedTeamBrief brief={brief} sides={sides} />;
  if (form === "roundtable") return <RoundtableBrief brief={brief} />;
  return <DebateBrief brief={brief} sides={sides} />;
}

/** 正反辩论: 裁决先行 (倾向 + 置信) → 关键争点 → 各方最强论点 → 分歧归类 → 建议 → 待解. */
function DebateBrief({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  return (
    <section className={brandPanelPrimary}>
      <VerdictHero
        label="结论倾向"
        leaning={brief.leaning}
        confidence={brief.confidence}
      />
      <BriefField icon={<Target size={14} />} label="关键争点">
        <p className="text-sm text-foreground">{brief.crux}</p>
      </BriefField>
      <SidePointsGrid
        label="各方最强论点"
        sides={sides}
        points={brief.strongest_points}
      />
      <DisputeSection brief={brief} />
      <RecommendationField label="建议" text={brief.recommendation} />
      <OpenQuestions items={brief.open_questions} />
    </section>
  );
}

/**
 * 红队审查: 风险清单 + 加固建议先行 (产物侧重). subject (被审方案) vs 红队 split off
 * `is_subject`——每个红队成员的「最强论点」即一条最尖锐的风险、被审方的即其抗辩，
 * recommendation 即加固建议。
 */
function RedTeamBrief({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const subject = sides.find((s) => s.is_subject) ?? null;
  const risks = sides
    .filter((s) => !s.is_subject)
    .map((s) => ({ name: s.name, text: brief.strongest_points[s.key] }))
    .filter((r): r is { name: string; text: string } => Boolean(r.text));
  const defense = subject ? brief.strongest_points[subject.key] : undefined;
  return (
    <section className={brandPanelPrimary}>
      <VerdictHero
        label="方案评定"
        leaning={brief.leaning}
        confidence={brief.confidence}
      />

      {risks.length > 0 && (
        <div>
          <h4 className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <ShieldAlert size={14} className={statusAccentText.warning} />
            风险清单
          </h4>
          <ul className="space-y-1.5">
            {risks.map((r) => (
              <li
                key={r.name}
                className={`rounded-lg border p-2.5 ${surfaceSubtle.warning}`}
              >
                <span
                  className={`text-xs font-medium ${statusAccentText.warning}`}
                >
                  {r.name}
                </span>
                <p className="mt-1 text-sm text-foreground">{r.text}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {brief.recommendation && (
        <div className={`rounded-lg border p-2.5 ${surfaceSubtle.primary}`}>
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium text-primary">
            <Wrench size={14} />
            加固建议
          </h4>
          <p className="text-sm text-foreground">{brief.recommendation}</p>
        </div>
      )}

      {defense && (
        <BriefField
          icon={<ShieldCheck size={14} className={statusAccentText.primary} />}
          label={subject ? `方案方回应（${subject.name}）` : "方案方回应"}
        >
          <p className="text-sm text-foreground">{defense}</p>
        </BriefField>
      )}

      <DisputeSection brief={brief} />
      <OpenQuestions items={brief.open_questions} />
    </section>
  );
}

/**
 * 圆桌探讨「观点光谱」英雄区 (置顶 glanceable) —— 探讨类产物侧重观点地图而非单一裁决
 * (辩论编排设计.md §三/§4.3)，故把光谱从简报里提到**叙事之前的顶部**：一眼看清「谁在桌上、各
 * 持什么、综合观察是什么」，无需先读完两轮长文。完整的共同焦点/分歧归类/待解留作下方简报小结
 * ({@link RoundtableBrief})——「先给地图、再读论点」(对标 Kialo 的 Display-first)。
 */
export function RoundtableSpectrum({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  return (
    <section className={brandPanelPrimary}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Users size={15} className={statusAccentText.primary} />
        圆桌观点光谱
      </h3>
      <SidePointsGrid
        label="各视角核心主张"
        sides={sides}
        points={brief.strongest_points}
      />
      {brief.leaning && (
        <div className={`${surfaceMutedPanel} p-3`}>
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <MessagesSquare size={14} />
            综合观察
          </h4>
          <p className="text-sm text-foreground">{brief.leaning}</p>
          {brief.recommendation && (
            <p className="mt-1.5 text-sm text-muted-foreground">
              建议：{brief.recommendation}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 圆桌探讨简报小结 (叙事**之后**收尾) —— 观点光谱已提到顶部 {@link RoundtableSpectrum}，这里只
 * 留「读完全程再回看」的分析：共同焦点 → 分歧归类 → 待解问题。探讨无「赢家」，故不挂置信表。
 */
function RoundtableBrief({ brief }: { brief: DebateBriefInfo }) {
  if (
    !brief.crux &&
    brief.factual_disputes.length === 0 &&
    brief.value_disputes.length === 0 &&
    brief.open_questions.length === 0
  ) {
    return null;
  }
  return (
    <section className={`${surfaceMutedPanel} space-y-3 p-4`}>
      {brief.crux && (
        <BriefField icon={<Target size={14} />} label="共同焦点">
          <p className="text-sm text-foreground">{brief.crux}</p>
        </BriefField>
      )}
      <DisputeSection brief={brief} />
      <OpenQuestions items={brief.open_questions} />
    </section>
  );
}

/** 裁决 hero: 倾向 prominent + 置信信号条 + 置信成立条件全文. Label varies by form. */
function VerdictHero({
  label,
  leaning,
  confidence,
}: {
  label: string;
  leaning: string;
  confidence: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Scale
        size={16}
        className={`mt-1 shrink-0 ${statusAccentText.primary}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <ConfidenceMeter level={confidenceLevel(confidence)} />
        </div>
        <p className="mt-1 text-base font-semibold leading-snug text-foreground">
          {leaning}
        </p>
        {/* 置信成立条件全文 (倾向在什么前提下反转) —— 简报的核心诚实，过去藏在 level 里没显. */}
        {confidence && (
          <p className="mt-1 text-xs text-muted-foreground">{confidence}</p>
        )}
      </div>
    </div>
  );
}

/** 置信度 → label + 配色 token (a classification, not a run-status color). */
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** 把主持人产出的【自由文本置信度】(含中文「高/中/低」+ 成立条件) 归一成三档信号。后端 confidence
 * 是一句带条件的话 (非枚举)，故按关键词识别：先英文 enum、再中文字。识别不到落 medium。 */
function confidenceLevel(raw: string): ConfidenceLevel {
  const s = raw.toLowerCase();
  if (CONFIDENCE_LEVELS.includes(s as ConfidenceLevel)) {
    return s as ConfidenceLevel;
  }
  if (s.includes("high") || raw.includes("高")) return "high";
  if (s.includes("low") || raw.includes("低")) return "low";
  return "medium";
}

/** 置信度信号条 (high/medium/low → 3/2/1 段实填) + 文字标签, so confidence reads as a
 * glanceable signal-strength meter beside the verdict, not just a word. Color tracks
 * {@link confidencePill} (success/warning/muted) for a consistent classification. */
const CONFIDENCE_BAR: Record<
  ConfidenceLevel,
  { filled: number; fill: string }
> = {
  high: { filled: 3, fill: "bg-success" },
  medium: { filled: 2, fill: "bg-warning" },
  low: { filled: 1, fill: "bg-muted-foreground/50" },
};

function ConfidenceMeter({ level }: { level: ConfidenceLevel }) {
  const { filled, fill } = CONFIDENCE_BAR[level];
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="flex items-end gap-0.5" aria-hidden>
        {[5, 8, 11].map((h, i) => (
          <span
            key={h}
            className={`w-1 rounded-full ${i < filled ? fill : "bg-muted"}`}
            style={{ height: h }}
          />
        ))}
      </span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${confidencePill[level]}`}
      >
        置信 {confidenceLabel[level]}
      </span>
    </span>
  );
}

/** 各方最强论点 / 观点光谱: one cell per side, keyed off `points[side.key]`. 每格按该方**身份色**
 * (与叙事线发言格、协作图节点同源 `agentColorVar`) 着左边缘 + 名称，让用户顺色追踪同一方的论点
 * 链 (遵 color-tokens 身份色板：内联 var、不与状态色竞争)。 */
function SidePointsGrid({
  label,
  sides,
  points,
}: {
  label: string;
  sides: DebateSideInfo[];
  points: Record<string, string>;
}) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </h4>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {sides.map((s) => {
          const colorVar = agentColorVar(s.name);
          return (
            <div
              key={s.key}
              className="rounded-lg border border-l-2 border-border bg-card p-2.5"
              style={{ borderLeftColor: colorVar }}
            >
              <span className="text-xs font-medium" style={{ color: colorVar }}>
                {s.name}
              </span>
              <p className="mt-1 text-sm text-foreground">
                {points[s.key] ?? "—"}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 分歧归类: 事实分歧 (靠证据可厘清) vs 价值分歧 (需你拍板) as a semantic contrast. */
function DisputeSection({ brief }: { brief: DebateBriefInfo }) {
  if (
    brief.factual_disputes.length === 0 &&
    brief.value_disputes.length === 0
  ) {
    return null;
  }
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
        分歧归类
      </h4>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {brief.factual_disputes.length > 0 && (
          <DisputeBlock
            tone="neutral"
            icon={<SearchCheck size={14} />}
            label="事实分歧"
            hint="靠证据可厘清"
            items={brief.factual_disputes}
          />
        )}
        {brief.value_disputes.length > 0 && (
          <DisputeBlock
            tone="warning"
            icon={<UserRound size={14} />}
            label="价值分歧"
            hint="需你拍板"
            items={brief.value_disputes}
          />
        )}
      </div>
    </div>
  );
}

/** 建议 / 加固建议 field (empty → omitted). */
function RecommendationField({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <BriefField
      icon={<Lightbulb size={14} className={statusAccentText.warning} />}
      label={label}
    >
      <p className="text-sm text-foreground">{text}</p>
    </BriefField>
  );
}

/** 待解问题 list (empty → omitted). */
function OpenQuestions({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <BriefList icon={<HelpCircle size={14} />} label="待解问题" items={items} />
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

/** A labelled bullet list in the brief card (待解问题). */
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
 * 分歧归类的一格 (辩论编排设计.md §4.1「关键事实分歧 vs 价值/偏好分歧」). 把两类分歧从两条
 * 等权 bullet list 升级为语义对比块：事实分歧「靠证据可厘清」(中性)、价值分歧「需你拍板」
 * (warning · 待裁决语义)，让用户一眼分清「哪些 AI 能帮判、哪些得我自己定」。
 */
function DisputeBlock({
  tone,
  icon,
  label,
  hint,
  items,
}: {
  tone: "neutral" | "warning";
  icon: ReactNode;
  label: string;
  hint: string;
  items: string[];
}) {
  const accent =
    tone === "warning" ? statusAccentText.warning : statusAccentText.primary;
  const shell =
    tone === "warning" ? surfaceSubtle.warning : "border-border bg-card";
  return (
    <div className={`rounded-lg border p-2.5 ${shell}`}>
      <div className="flex items-center gap-1.5">
        <span className={`shrink-0 ${accent}`}>{icon}</span>
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">· {hint}</span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {items.map((it) => (
          <li key={it} className="flex gap-1.5 text-sm text-foreground">
            <span className="shrink-0 text-muted-foreground">·</span>
            <span className="min-w-0 flex-1">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
