import { Card } from "@/components/ui";
import { statusPillInline } from "@/components/ui/tone-presets";
import type { DebateBriefInfo, DebateSideInfo } from "@/types/events";
import {
  Lightbulb,
  MessagesSquare,
  ShieldAlert,
  ShieldCheck,
  Target,
  Users,
} from "lucide-react";
import { SideIdentity } from "../../SideChip";
import {
  FINDING_SEVERITY,
  FINDING_STATUS,
  findingDispositionLabel,
  gateLabel,
  sortFindings,
} from "../../findings";
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
import { ConsensusMap } from "../ConsensusMap";
import { VerdictCard, YourCallZone, briefHandoffs } from "./shared";

/**
 * 旧场红队 / 圆桌终审块（含光谱 / 共识图）。正反热路径不静态导入本文件。
 */
export function ReplayBriefCard({
  brief,
  sides,
  form,
  subtopics,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
  form: DebateForm;
  subtopics?: string[] | null;
}) {
  if (form === "red_team") return <RedTeamBrief brief={brief} sides={sides} />;
  if (form === "roundtable") {
    return (
      <>
        <RoundtableSpectrum brief={brief} sides={sides} subtopics={subtopics} />
        <RoundtableBrief brief={brief} />
      </>
    );
  }
  return null;
}

/** 红队同构：① 门决评定 → ② finding 台账（或旧 RiskBoard 降级）→ ③ 留给你的 */
function RedTeamBrief({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const subject = sides.find((s) => s.is_subject) ?? null;
  const findings = brief.findings ?? [];
  const hasFindings = findings.length > 0;
  const risks = hasFindings ? [] : buildRiskItems(sides, brief);
  const defense = subject ? brief.strongest_points[subject.key] : undefined;
  const mustFix = brief.must_fix ?? [];
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <VerdictCard
          brief={brief}
          form="red_team"
          sides={sides}
          gate={gateLabel(brief.gate)}
        />
      </Card>
      {hasFindings ? (
        <BriefFindingBoard
          findings={findings}
          sides={sides}
          mustFix={mustFix}
        />
      ) : (
        <div className="space-y-3">
          <RiskBoard risks={risks} />
          {defense && subject && (
            <div>
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
        </div>
      )}
      <YourCallZone
        shell="card"
        handoffs={briefHandoffs(brief)}
        recommendation={brief.recommendation}
        form="red_team"
      />
    </div>
  );
}

/** 终审区 finding 摘要台账（结构字段；全文已在轮内英雄区）。 */
function BriefFindingBoard({
  findings,
  sides,
  mustFix,
}: {
  findings: NonNullable<DebateBriefInfo["findings"]>;
  sides: DebateSideInfo[];
  mustFix: string[];
}) {
  const nameByKey = new Map(sides.map((s) => [s.key, s.name]));
  const ordered = sortFindings(findings);
  const mustSet = new Set(mustFix);
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h4 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <ShieldAlert size={14} />
          Finding 下场
        </h4>
        {mustFix.length > 0 && (
          <span className={statusPillInline.destructive}>
            must-fix {mustFix.length}
          </span>
        )}
      </div>
      <ul className="space-y-1.5">
        {ordered.map((f) => {
          const sev = FINDING_SEVERITY[f.severity];
          const st = FINDING_STATUS[f.status];
          const attacker = nameByKey.get(f.attacker_key) ?? f.attacker_key;
          const disposition = findingDispositionLabel(f.disposition ?? "");
          return (
            <li key={f.id} className={sev.surface}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={sev.pill}>{sev.label}</span>
                <span className={st.pill}>{st.label}</span>
                {mustSet.has(f.id) && (
                  <span className={statusPillInline.destructive}>must-fix</span>
                )}
                <SideIdentity
                  name={attacker}
                  colorVar={debateSideColorVar(f.attacker_key, attacker)}
                />
              </div>
              <p className="mt-1 text-sm text-foreground">
                {f.target}
                {disposition ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · 处置 {disposition}
                  </span>
                ) : null}
              </p>
            </li>
          );
        })}
      </ul>
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

/**
 * 圆桌：有 consensus_map → 共识/分歧地图；否则降级旧观点光谱。
 * 共同焦点 / 分歧由 RoundtableBrief → ③ 区处理。
 */
export function RoundtableSpectrum({
  brief,
  sides,
  subtopics,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
  subtopics?: string[] | null;
}) {
  const map = brief.consensus_map ?? [];
  if (map.length > 0) {
    return (
      <ConsensusMap
        items={map}
        sides={sides}
        subtopics={subtopics}
        strongestPoints={brief.strongest_points}
        leaning={brief.leaning}
        recommendation={brief.recommendation}
      />
    );
  }
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
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <h4 className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <MessagesSquare size={14} />
            综合观察
          </h4>
          <p className="text-sm text-foreground">{brief.leaning}</p>
          {brief.recommendation && (
            <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted-foreground">
              <Lightbulb size={14} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-medium text-foreground">建议：</span>
                {brief.recommendation}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 圆桌 ③：共同焦点 + 留给你的 */
function RoundtableBrief({
  brief,
}: {
  brief: DebateBriefInfo;
}) {
  const handoffs = briefHandoffs(brief);
  if (!brief.crux && handoffs.length === 0) {
    return null;
  }
  return (
    <Card className="space-y-4 p-4">
      {brief.crux && (
        <p className="flex items-start gap-1.5 text-sm text-foreground">
          <Target size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span>
            <span className="font-medium">共同焦点：</span>
            {brief.crux}
          </span>
        </p>
      )}
      <YourCallZone divided={!!brief.crux} handoffs={handoffs} />
    </Card>
  );
}

/** 圆桌光谱等轻量网格（无比分条）。 */
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
          const colorVar = debateSideColorVar(s.key, s.name);
          return (
            <div key={s.key} className="border-l-2 border-border pl-2.5">
              <SideIdentity name={s.name} colorVar={colorVar} />
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
