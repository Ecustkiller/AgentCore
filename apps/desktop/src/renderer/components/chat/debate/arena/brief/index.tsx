import type { DebateBriefInfo, DebateSideInfo } from "@/types/events";
import {
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Lightbulb,
  MessagesSquare,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  Target,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { SideIdentity } from "../../SideChip";
import { type DebateForm, debateSideColorVar } from "../../model";
import {
  RISK_LEVELS,
  RISK_SEVERITY,
  type RiskItem,
  type RiskLevel,
  buildRiskItems,
  rankOf,
  riskCounts,
} from "../../severity";

export function BriefCard({
  brief,
  sides,
  form,
  scores,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
  form: DebateForm;
  scores?: Record<string, number>;
}) {
  if (form === "red_team") return <RedTeamBrief brief={brief} sides={sides} />;
  if (form === "roundtable") return <RoundtableBrief brief={brief} />;
  return <DebateBrief brief={brief} sides={sides} scores={scores} />;
}

function DebateBrief({
  brief,
  sides,
  scores,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
  scores?: Record<string, number>;
}) {
  return (
    <div className="space-y-3">
      <SidePointsGrid
        label="双方一眼看"
        sides={sides}
        points={brief.strongest_points}
        scores={scores}
      />
      <DisputeTriage
        value={brief.value_disputes}
        factual={brief.factual_disputes}
      />
      <RecommendationInline text={brief.recommendation} />
      {hasClarify(brief) && (
        <Disclosure summary="展开依据" teaser={evidenceTeaser(brief, false)}>
          <StillToClarify
            factual={brief.factual_disputes}
            open={brief.open_questions}
          />
        </Disclosure>
      )}
    </div>
  );
}

function RedTeamBrief({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const subject = sides.find((s) => s.is_subject) ?? null;
  const risks = buildRiskItems(sides, brief);
  const defense = subject ? brief.strongest_points[subject.key] : undefined;
  return (
    <div className="space-y-3">
      <DisputeTriage
        value={brief.value_disputes}
        factual={brief.factual_disputes}
      />
      <RiskBoard risks={risks} />
      {brief.recommendation && (
        <div className="border-l-2 border-border pl-2.5">
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Wrench size={14} />
            加固建议
          </h4>
          <p className="text-sm text-foreground">{brief.recommendation}</p>
        </div>
      )}
      {defense && subject && (
        <div className="border-l-2 border-border pl-2.5">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <ShieldCheck size={14} className="text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              方案方回应
            </span>
            <SideIdentity
              name={subject.name}
              colorVar={debateSideColorVar(subject.key, subject.name)}
              model={subject.model}
            />
          </div>
          <p className="text-sm text-foreground">{defense}</p>
        </div>
      )}
      {hasClarify(brief) && (
        <Disclosure summary="展开依据" teaser={evidenceTeaser(brief, false)}>
          <StillToClarify
            factual={brief.factual_disputes}
            open={brief.open_questions}
          />
        </Disclosure>
      )}
    </div>
  );
}

function RiskBoard({ risks }: { risks: RiskItem[] }) {
  if (risks.length === 0) return null;
  const counts = riskCounts(risks);
  const ordered = [...risks].sort((a, b) => rankOf(a.level) - rankOf(b.level));
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h4 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <ShieldAlert size={14} />
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
              className={meta?.surface ?? "border-l-2 border-border pl-2.5"}
            >
              <div className="flex items-center justify-between gap-2">
                <SideIdentity
                  name={r.side.name}
                  colorVar={debateSideColorVar(r.side.key, r.side.name)}
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

export function RoundtableSpectrum({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Users size={15} className="text-muted-foreground" />
        圆桌观点光谱
      </h3>
      <SidePointsGrid
        label="各视角核心主张"
        sides={sides}
        points={brief.strongest_points}
      />
      {brief.leaning && (
        <div className="border-t border-border pt-2.5">
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
    </div>
  );
}

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
      <DisputeTriage
        value={brief.value_disputes}
        factual={brief.factual_disputes}
      />
      {hasClarify(brief) && (
        <Disclosure summary="展开依据" teaser={evidenceTeaser(brief, false)}>
          <StillToClarify
            factual={brief.factual_disputes}
            open={brief.open_questions}
          />
        </Disclosure>
      )}
    </div>
  );
}

function DisputeTriage({
  value,
  factual,
}: {
  value: string[];
  factual: string[];
}) {
  if (value.length === 0 && factual.length === 0) return null;
  const hasValue = value.length > 0;
  return (
    <div className={hasValue ? "border-l-2 border-border pl-2.5" : ""}>
      {hasValue && (
        <>
          <h4 className="flex flex-wrap items-center gap-1 text-xs font-medium text-foreground">
            <UserRound size={14} className="text-muted-foreground" />
            <span>价值 / 偏好之争</span>
            <span className="text-muted-foreground">· AI 判不了，需你定夺</span>
          </h4>
          <ul className="mt-1.5 space-y-1">
            {value.map((it) => (
              <li key={it} className="flex gap-1.5 text-sm text-foreground">
                <span className="shrink-0 text-muted-foreground">·</span>
                <span className="min-w-0 flex-1">{it}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {factual.length > 0 && (
        <p
          className={`flex items-start gap-1 text-xs text-muted-foreground ${hasValue ? "mt-2 border-t border-border/60 pt-2" : ""}`}
        >
          <SearchCheck size={13} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium text-foreground">
              事实分歧 {factual.length}
            </span>
            <span> · 靠证据可厘清，无需你定夺（见下方依据）</span>
          </span>
        </p>
      )}
    </div>
  );
}

function hasClarify(brief: DebateBriefInfo): boolean {
  return brief.factual_disputes.length > 0 || brief.open_questions.length > 0;
}

function evidenceTeaser(
  brief: DebateBriefInfo,
  withSidePoints: boolean,
): string {
  return [
    withSidePoints ? "各方论点" : null,
    brief.factual_disputes.length
      ? `事实分歧 ${brief.factual_disputes.length}`
      : null,
    brief.open_questions.length ? `待解 ${brief.open_questions.length}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function Disclosure({
  summary,
  teaser,
  children,
}: {
  summary: ReactNode;
  teaser?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium text-foreground">{summary}</span>
        {teaser && <span className="min-w-0 truncate">· {teaser}</span>}
        <span className="ml-auto shrink-0">{open ? "收起" : "展开"}</span>
      </button>
      {open && <div className="space-y-3 pt-2">{children}</div>}
    </div>
  );
}

function RecommendationInline({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="flex items-start gap-1.5 text-sm text-foreground">
      <Lightbulb size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
      <span>
        <span className="font-medium">建议：</span>
        {text}
      </span>
    </p>
  );
}

function StillToClarify({
  factual,
  open,
}: {
  factual: string[];
  open: string[];
}) {
  if (factual.length === 0 && open.length === 0) return null;
  return (
    <div className="space-y-2">
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

function SidePointsGrid({
  label,
  sides,
  points,
  scores,
}: {
  label: string;
  sides: DebateSideInfo[];
  points: Record<string, string>;
  scores?: Record<string, number>;
}) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </h4>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {sides.map((s) => {
          const colorVar = debateSideColorVar(s.key, s.name);
          const score = scores?.[s.key];
          return (
            <div key={s.key} className="border-l-2 border-border pl-2.5">
              <div className="flex items-center justify-between gap-1.5">
                <SideIdentity
                  name={s.name}
                  colorVar={colorVar}
                  model={s.model}
                />
                {score !== undefined && (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-xs font-semibold tabular-nums text-foreground">
                    净 {score}
                  </span>
                )}
              </div>
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
