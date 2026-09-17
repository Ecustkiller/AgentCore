import { Card, SectionLabel } from "@/components/ui";
import {
  confidenceLabel,
  confidencePill,
  statusPillInline,
} from "@/components/ui/tone-presets";
import { cn } from "@/lib/utils";
import type {
  DebateBriefInfo,
  DebateHandoffInfo,
  DebateSideInfo,
} from "@/types/events";
import { Lightbulb, Scale, Swords, Target, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import {
  type StanceSide,
  splitFactDisplay,
  splitLeaning,
  splitValueCall,
} from "./split";

/** 交接清单 kind；坏 kind 容错归 question（契约不变）。 */
type HandoffKind = "value" | "fact" | "question";

function asHandoffKind(raw: string): HandoffKind {
  return raw === "value" || raw === "fact" || raw === "question"
    ? raw
    : "question";
}

export function briefHandoffs(brief: DebateBriefInfo): DebateHandoffInfo[] {
  return (brief.handoffs ?? []).map((h) => ({
    kind: asHandoffKind(h.kind),
    text: h.text,
  }));
}

/**
 * 裁决区：站队徽章 + 命题 + 反转次行 + 胜负手。外壳由父级 Card 提供。
 */
export function VerdictCard({
  brief,
  form,
  sides,
  gate = null,
}: {
  brief: DebateBriefInfo;
  form: "debate" | "red_team";
  sides?: DebateSideInfo[];
  /** 红队门决文案；正反不传。 */
  gate?: string | null;
}) {
  const label = form === "red_team" ? "方案评定" : "结论倾向";
  const level = confidenceLevel(brief.confidence);
  const showCrux = form === "red_team" && !!brief.crux;
  const { stanceLabel, stanceSide, thesis, reversal } = splitLeaning(
    brief.leaning,
    sides,
  );
  const heading = thesis || stanceLabel || brief.leaning;
  const showStancePill = Boolean(stanceLabel && thesis);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel className="flex items-center gap-1">
          <Scale size={13} />
          {label}
        </SectionLabel>
        <div className="flex shrink-0 items-center gap-1.5">
          {showStancePill && stanceLabel ? (
            <StancePill label={stanceLabel} side={stanceSide} />
          ) : null}
          {gate && <span className={statusPillInline.primary}>{gate}</span>}
          <span
            className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${confidencePill[level]}`}
          >
            把握 {confidenceLabel[level]}
          </span>
        </div>
      </div>
      {heading ? (
        <p
          className="mt-2 text-base font-semibold leading-snug text-foreground"
          style={
            !showStancePill && stanceSide
              ? {
                  color:
                    stanceSide === "pro"
                      ? "var(--debate-side-pro)"
                      : "var(--debate-side-con)",
                }
              : undefined
          }
        >
          {heading}
        </p>
      ) : null}
      {reversal ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{reversal}</p>
      ) : null}
      {(brief.decisive || showCrux) && (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          {brief.decisive && (
            <ReasonRow
              icon={<Swords size={13} />}
              label={form === "red_team" ? "定门决" : "胜负手"}
            >
              {brief.decisive}
            </ReasonRow>
          )}
          {showCrux && (
            <ReasonRow icon={<Target size={13} />} label="争点">
              {brief.crux}
            </ReasonRow>
          )}
        </div>
      )}
    </div>
  );
}

function StancePill({
  label,
  side,
}: {
  label: string;
  side: StanceSide;
}) {
  const colorVar =
    side === "pro"
      ? "var(--debate-side-pro)"
      : side === "con"
        ? "var(--debate-side-con)"
        : null;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-xs font-medium",
        !colorVar && statusPillInline.muted,
      )}
      style={
        colorVar
          ? {
              color: colorVar,
              background: `color-mix(in oklch, ${colorVar} 14%, transparent)`,
            }
          : undefined
      }
    >
      {label}
    </span>
  );
}

function ReasonRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>
        <span className="font-medium text-foreground">{label}</span>
        <span className="mx-1">·</span>
        {children}
      </span>
    </p>
  );
}

/**
 * 留给你的：与裁决同一套 SectionLabel + 列表，不另起蓝底壳、不挂关口按钮。
 * value = 问句（对照小条不是选项）；fact = 还没核实；question = 只能等。
 */
export function YourCallZone({
  handoffs,
  recommendation,
  form,
  divided = false,
  shell = "plain",
}: {
  handoffs: DebateHandoffInfo[];
  recommendation?: string;
  form?: "debate" | "red_team";
  divided?: boolean;
  shell?: "plain" | "card";
}) {
  const values = handoffs.filter((h) => asHandoffKind(h.kind) === "value");
  const facts = handoffs.filter((h) => asHandoffKind(h.kind) === "fact");
  const questions = handoffs.filter(
    (h) => asHandoffKind(h.kind) === "question",
  );
  const hasHandoffs =
    values.length > 0 || facts.length > 0 || questions.length > 0;
  if (!hasHandoffs && !recommendation) {
    return null;
  }

  const recLabel = form === "red_team" ? "加固建议" : "建议";

  const inner = (
    <div
      className={cn("space-y-3", divided && "mt-3 border-t border-border pt-3")}
    >
      <SectionLabel className="flex items-center gap-1">
        <UserRound size={13} />
        留给你的
      </SectionLabel>
      {recommendation && (
        <p className="flex items-start gap-1.5 text-sm text-foreground">
          <Lightbulb
            size={14}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <span>
            <span className="font-medium">{recLabel}：</span>
            {recommendation}
          </span>
        </p>
      )}
      {values.length > 0 && (
        <ul className="space-y-3">
          {values.map((it) => (
            <li key={it.text}>
              <ValueCallItem text={it.text} />
            </li>
          ))}
        </ul>
      )}
      {facts.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>还没核实</SectionLabel>
          <ul className="space-y-2">
            {facts.map((it) => (
              <li key={it.text}>
                <FactItem text={it.text} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {questions.length > 0 && (
        <div className="space-y-1.5">
          <SectionLabel>只能等</SectionLabel>
          <p className="text-sm text-muted-foreground">
            {questions.map((h) => h.text).join("；")}
          </p>
        </div>
      )}
    </div>
  );

  return shell === "card" ? <Card className="p-4">{inner}</Card> : inner;
}

/** value：问句 + 可选对照条（不是可点选项）。 */
function ValueCallItem({ text }: { text: string }) {
  const { question, mappings } = splitValueCall(text);
  const questionMark = /[？?。！!…]$/.test(question) ? "" : "？";
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium leading-snug text-foreground">
        {question}
        {questionMark ? (
          <span className="text-muted-foreground">{questionMark}</span>
        ) : null}
      </p>
      {mappings.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mappings.map((m) => (
            <span
              key={m}
              className="rounded-lg bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {m}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function FactItem({ text }: { text: string }) {
  const { body, statusLabels } = splitFactDisplay(text);
  return (
    <p className="flex flex-wrap items-baseline gap-1.5 text-sm text-foreground">
      {statusLabels.map((label) => (
        <span key={label} className={statusPillInline.muted}>
          {label}
        </span>
      ))}
      <span>{body || text}</span>
    </p>
  );
}

const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

function confidenceLevel(raw: string): ConfidenceLevel {
  const s = raw.toLowerCase();
  if (CONFIDENCE_LEVELS.includes(s as ConfidenceLevel))
    return s as ConfidenceLevel;
  if (s.includes("high") || raw.includes("高")) return "high";
  if (s.includes("low") || raw.includes("低")) return "low";
  return "medium";
}
