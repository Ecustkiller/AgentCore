import {
  brandPanelPrimary,
  confidenceLabel,
  confidencePill,
  statusAccentText,
  statusPillInline,
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
import { SideIdentity } from "./SideChip";
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

/**
 * 正反辩论 (结论先行 · 主次分明)：**裁决英雄卡**（倾向 + 置信 + 争点 + 需你拍板 + 建议）独占焦点
 * → 各方最强论点速览 → 弱化的「还需厘清」。把对用户最有行动价值的**价值之争（需你拍板）**提进裁决
 * 卡紧跟倾向，事实分歧 / 待解降级收尾——根治旧版「6 段等权堆叠、找不到落点」的杂（用户反馈）。
 */
function DebateBrief({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  return (
    <div className="space-y-3">
      <section className={brandPanelPrimary}>
        <VerdictHero
          label="结论倾向"
          leaning={brief.leaning}
          confidence={brief.confidence}
        />
        <CruxLine crux={brief.crux} />
        <DecisionNeeded items={brief.value_disputes} />
        <RecommendationInline text={brief.recommendation} />
      </section>
      <SidePointsGrid
        label="各方最强论点"
        sides={sides}
        points={brief.strongest_points}
      />
      <StillToClarify
        factual={brief.factual_disputes}
        open={brief.open_questions}
      />
    </div>
  );
}

/**
 * 红队审查 (结论先行 · 与正反辩论同一套主次)：**方案评定英雄卡**（评定 + 置信 + 需你拍板）独占焦点
 * → 风险清单（产物侧重，每条红队成员的最尖锐风险）→ 加固建议 → 方案方回应 → 弱化的「还需厘清」。
 * subject (被审方案) 由 `is_subject` 分出：红队成员的「最强论点」即风险、被审方的即抗辩，
 * recommendation 即加固建议。价值之争提进英雄卡（{@link DecisionNeeded}）、事实分歧 / 待解降级收尾
 * （{@link StillToClarify}）——与 {@link DebateBrief} 同骨架，去掉旧版等权 DisputeSection（三形态一致）。
 */
function RedTeamBrief({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const subject = sides.find((s) => s.is_subject) ?? null;
  const severities = brief.risk_severities ?? {};
  const risks: RiskItem[] = sides
    .filter((s) => !s.is_subject)
    .map((s) => ({
      side: s,
      text: brief.strongest_points[s.key],
      level: riskLevelOf(severities[s.key]),
    }))
    .filter((r): r is RiskItem => Boolean(r.text));
  const defense = subject ? brief.strongest_points[subject.key] : undefined;
  return (
    <div className="space-y-3">
      <section className={brandPanelPrimary}>
        <VerdictHero
          label="方案评定"
          leaning={brief.leaning}
          confidence={brief.confidence}
        />
        <DecisionNeeded items={brief.value_disputes} />
      </section>

      <RiskBoard risks={risks} />

      {brief.recommendation && (
        <div className={`rounded-lg border p-2.5 ${surfaceSubtle.primary}`}>
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium text-primary">
            <Wrench size={14} />
            加固建议
          </h4>
          <p className="text-sm text-foreground">{brief.recommendation}</p>
        </div>
      )}

      {defense && subject && (
        <div
          className="rounded-lg border border-l-2 border-border bg-card p-2.5"
          style={{ borderLeftColor: agentColorVar(subject.name) }}
        >
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <ShieldCheck size={14} className={statusAccentText.primary} />
            <span className="text-xs font-medium text-muted-foreground">
              方案方回应
            </span>
            <SideIdentity
              name={subject.name}
              colorVar={agentColorVar(subject.name)}
              model={subject.model}
            />
          </div>
          <p className="text-sm text-foreground">{defense}</p>
        </div>
      )}

      <StillToClarify
        factual={brief.factual_disputes}
        open={brief.open_questions}
      />
    </div>
  );
}

/** 红队风险严重度三档 → 展示元数据（与后端 `risk_severities` 的 high/medium/low 同口径）。注意
 * 语义与 {@link confidencePill} 相反：风险 high=最坏=destructive(红)、low=最轻=muted(灰)，故另起一套
 * 而非复用置信色。`rank` 决定看板内由危到轻的排序。 */
const RISK_SEVERITY = {
  high: {
    label: "高危",
    rank: 0,
    pill: statusPillInline.destructive,
    surface: "border-destructive/30 bg-destructive/5",
  },
  medium: {
    label: "中危",
    rank: 1,
    pill: statusPillInline.warning,
    surface: surfaceSubtle.warning,
  },
  low: {
    label: "低危",
    rank: 2,
    pill: statusPillInline.muted,
    surface: "border-border bg-muted/30",
  },
} as const;
type RiskLevel = keyof typeof RISK_SEVERITY;
const RISK_LEVELS = ["high", "medium", "low"] as const;
type RiskItem = { side: DebateSideInfo; text: string; level: RiskLevel | null };

/** 把后端风险严重度（已归一为 high/medium/low）映射成档位；容忍中文「高/中/低」与同义词，识别不到
 * （如旧产物无此字段）返回 null = 未评级（看板降级为中性卡，不杜撰档位）。 */
function riskLevelOf(raw: string | undefined): RiskLevel | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if ((RISK_LEVELS as readonly string[]).includes(s)) return s as RiskLevel;
  if (s.includes("high") || raw.includes("高")) return "high";
  if (s.includes("low") || raw.includes("低")) return "low";
  if (s.includes("medium") || raw.includes("中")) return "medium";
  return null;
}

function rankOf(level: RiskLevel | null): number {
  return level ? RISK_SEVERITY[level].rank : 99;
}

/**
 * 风险看板（红队产物侧重）：把红队成员的最尖锐风险按严重度【总览计数 + 由危到轻排序 + 分级配色】
 * 呈现——顶部一行盘口计数让用户一眼看清风险结构（高危 N · 中危 N · 低危 N），卡片高危(红)→中危(黄)
 * →低危(灰)依次降权，取代旧版「等权平铺列表」。严重度取自 {@link DebateBriefInfo.risk_severities}；
 * 旧产物缺级时降级为无徽章中性卡（honest gap，不杜撰档位）。空清单整块省略。
 */
function RiskBoard({ risks }: { risks: RiskItem[] }) {
  if (risks.length === 0) return null;
  const counts: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0 };
  for (const r of risks) {
    if (r.level) counts[r.level] += 1;
  }
  const ordered = [...risks].sort((a, b) => rankOf(a.level) - rankOf(b.level));
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h4 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <ShieldAlert size={14} className={statusAccentText.warning} />
          风险清单
        </h4>
        <RiskTally counts={counts} />
      </div>
      <ul className="space-y-1.5">
        {ordered.map((r) => {
          const meta = r.level ? RISK_SEVERITY[r.level] : null;
          return (
            <li
              key={r.side.key}
              className={`rounded-lg border p-2.5 ${meta?.surface ?? "border-border bg-card"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <SideIdentity
                  name={r.side.name}
                  colorVar={agentColorVar(r.side.name)}
                  model={r.side.model}
                />
                {meta && <span className={meta.pill}>{meta.label}</span>}
              </div>
              <p className="mt-1 text-sm text-foreground">{r.text}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 风险总览计数（看板盘口）：按 高→中→低 顺序展示非零档位的计数 chip。全部未评级则不渲染（无可计数）。 */
function RiskTally({ counts }: { counts: Record<RiskLevel, number> }) {
  const shown = RISK_LEVELS.filter((l) => counts[l] > 0);
  if (shown.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {shown.map((l) => (
        <span key={l} className={RISK_SEVERITY[l].pill}>
          {RISK_SEVERITY[l].label} {counts[l]}
        </span>
      ))}
    </div>
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
 * 留「读完全程再回看」的分析：共同焦点（一行）→ 需你拍板（价值之争）→ 弱化的「还需厘清」（事实分歧
 * + 待解）。探讨无「赢家」，故不挂置信表；与正反 / 红队同一套次级信息主次（去掉旧版等权 DisputeSection，
 * 三形态一致）。
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
    <div className="space-y-3">
      {brief.crux && (
        <p className="flex items-start gap-1.5 text-sm text-foreground">
          <Target size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span>
            <span className="font-medium">共同焦点：</span>
            {brief.crux}
          </span>
        </p>
      )}
      <DecisionNeeded items={brief.value_disputes} />
      <StillToClarify
        factual={brief.factual_disputes}
        open={brief.open_questions}
      />
    </div>
  );
}

/**
 * 裁决 hero: 倾向 prominent + **单一**置信表达（一枚档位 chip）+ 置信成立条件全文。Label varies
 * by form. 置信过去用「3 段信号条 + chip + 全文」三重表达同一件事（用户反馈看着像迷你图表 / 冗余），
 * 现只留 chip（档位）+ 成立条件句（条件，与档位互补、非重复）；当 confidence 只是裸档位词
 * （"medium"/"中"）时连句子也省，不把枚举当条件展示。
 */
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
          <ConfidenceChip level={confidenceLevel(confidence)} />
        </div>
        <p className="mt-1 text-base font-semibold leading-snug text-foreground">
          {leaning}
        </p>
        {confidence && !isBareLevel(confidence) && (
          <p className="mt-1 text-xs text-muted-foreground">{confidence}</p>
        )}
      </div>
    </div>
  );
}

/** 争点（框定双方真正分歧的一句话），压成裁决卡内一行 muted 注脚——比独立区块轻、不与倾向抢焦点. */
function CruxLine({ crux }: { crux: string }) {
  if (!crux) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Target size={13} className="mt-0.5 shrink-0" />
      <span>
        <span className="font-medium text-foreground">争点：</span>
        {crux}
      </span>
    </p>
  );
}

/**
 * 「需你拍板」= 价值 / 偏好之争（AI 判不了、必须老板定，辩论编排设计.md §4.1）。提进裁决卡、紧跟
 * 倾向——这是简报里对用户**最有行动价值**的一块，故 warning 语气强调（旧版与事实分歧等权埋在「分歧
 * 归类」里、被淹没）。空则省略。
 */
function DecisionNeeded({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className={`rounded-lg border p-2.5 ${surfaceSubtle.warning}`}>
      <h4 className="flex items-center gap-1 text-xs font-medium">
        <UserRound size={14} className={statusAccentText.warning} />
        <span className={statusAccentText.warning}>需你拍板</span>
        <span className="text-muted-foreground">
          · 价值 / 偏好之争，AI 判不了
        </span>
      </h4>
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

/** 建议，压成裁决卡内一行（旧版独立区块）。空则省略. */
function RecommendationInline({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="flex items-start gap-1.5 text-sm text-foreground">
      <Lightbulb
        size={14}
        className={`mt-0.5 shrink-0 ${statusAccentText.warning}`}
      />
      <span>
        <span className="font-medium">建议：</span>
        {text}
      </span>
    </p>
  );
}

/**
 * 「还需厘清」= 事实分歧（靠证据可厘清）+ 待解问题，合并成裁决卡**之后**的弱化收尾。价值之争已提进
 * 裁决卡（{@link DecisionNeeded}），这里只剩「AI 能帮判 / 尚未解决」的次要项 → 走中性 muted 面板、
 * 低视觉权重，与英雄裁决卡拉开主次。两者皆空则整块省略。
 */
function StillToClarify({
  factual,
  open,
}: {
  factual: string[];
  open: string[];
}) {
  if (factual.length === 0 && open.length === 0) return null;
  return (
    <div className={`${surfaceMutedPanel} space-y-2 p-3`}>
      <h4 className="text-xs font-medium text-muted-foreground">还需厘清</h4>
      {factual.length > 0 && (
        <ClarifyList
          icon={<SearchCheck size={13} />}
          label="事实分歧"
          hint="靠证据可厘清"
          items={factual}
        />
      )}
      {open.length > 0 && (
        <ClarifyList
          icon={<HelpCircle size={13} />}
          label="待解问题"
          items={open}
        />
      )}
    </div>
  );
}

/** 「还需厘清」里的一组：图标 + 标签（+ 可选 hint）+ bullet 列表. */
function ClarifyList({
  icon,
  label,
  hint,
  items,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  items: string[];
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="shrink-0">{icon}</span>
        <span className="font-medium text-foreground">{label}</span>
        {hint && <span>· {hint}</span>}
      </div>
      <ul className="mt-1 space-y-1">
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

/** 裸档位词集合（英文 enum + 中文「高/中/低」）。confidence 是裸档位时，档位 chip 已表达，
 * 不再把它当「成立条件」句子重复展示（见 {@link VerdictHero}）。 */
const BARE_LEVELS = new Set(["high", "medium", "low", "高", "中", "低"]);
function isBareLevel(raw: string): boolean {
  return BARE_LEVELS.has(raw.trim().toLowerCase());
}

/** 置信度档位 chip（success/warning/muted 分类色，遵 {@link confidencePill}）——置信的**唯一**
 * 视觉表达，取代旧的「信号条 + chip」双重表达. */
function ConfidenceChip({ level }: { level: ConfidenceLevel }) {
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${confidencePill[level]}`}
    >
      置信 {confidenceLabel[level]}
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
              <SideIdentity name={s.name} colorVar={colorVar} model={s.model} />
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
