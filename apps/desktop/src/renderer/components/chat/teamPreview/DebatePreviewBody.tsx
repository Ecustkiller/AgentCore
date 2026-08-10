import { formatCrossModelRosterLine } from "@/components/chat/debate/model";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { formatDebateBudgetLabel } from "./budget";
import type { TeamPreviewDebateView, TeamPreviewSideView } from "./types";

type DebatePreviewBodyProps = {
  mode?: "readonly" | "collapsible";
  debate: TeamPreviewDebateView;
  showBudget?: boolean;
  motionClassName?: string;
};

export type { DebatePreviewBodyProps };

/**
 * Debate motion / roster / sides — shared by hot TeamPreviewCard/Graph and cold
 * TeamPreviewResumeCard. Cold keeps collapsible stance + budget in header Badge.
 * 人改辩手/裁判模型 UI 已撤（后端 model_overrides 契约仍保留）。
 */
export function DebatePreviewBody({
  debate,
  mode = "readonly",
  showBudget = true,
  motionClassName = "whitespace-pre-wrap text-xs text-foreground",
}: DebatePreviewBodyProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const collapsible = mode === "collapsible";

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const budget = formatDebateBudgetLabel(debate.maxRounds, debate.thorough);
  const rosterLine = formatCrossModelRosterLine(debate.sides, {
    model: debate.moderatorModel,
    origin: debate.moderatorOrigin,
  });

  return (
    <div className="mt-2 space-y-1.5">
      {debate.motion && <p className={motionClassName}>{debate.motion}</p>}
      {showBudget && <p className="text-xs text-muted-foreground">{budget}</p>}
      {rosterLine && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="debate-roster-line"
        >
          {rosterLine}
        </p>
      )}
      {debate.sameModelDebate && (
        <p className="text-xs text-muted-foreground">同模型辩论</p>
      )}
      {debate.modelCandidates && debate.modelCandidates.length > 0 && (
        <div
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
          data-testid="debate-model-candidates"
        >
          <p className="text-xs font-medium text-foreground">
            模型消歧失败 · 请从目录候选重选（勿再问「是不是当前主模型」）
          </p>
          <ul className="mt-1 space-y-0.5">
            {debate.modelCandidates.map((c, i) => (
              <li
                key={`${c.origin}-${c.model}-${c.provider_id ?? ""}-${i}`}
                className="text-xs text-muted-foreground"
              >
                {c.label || c.model}
                {" · "}
                {c.origin}/{c.model}
                {c.provider_id ? `（provider=${c.provider_id}）` : ""}
                {c.side_key ? ` · ${c.side_key}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {debate.sides.map((s) => {
        const meta = <SideMeta s={s} />;

        if (!collapsible) {
          return (
            <div
              key={s.key}
              className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
            >
              {meta}
              {s.stance && (
                <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                  {s.stance}
                </p>
              )}
            </div>
          );
        }

        if (!s.stance) {
          return (
            <div
              key={s.key}
              className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
            >
              {meta}
            </div>
          );
        }

        const open = expanded.has(s.key);
        return (
          <div
            key={s.key}
            className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
          >
            <button
              type="button"
              onClick={() => toggle(s.key)}
              aria-expanded={open}
              aria-label={open ? `收起 ${s.name} 立场` : `展开 ${s.name} 立场`}
              className="w-full text-left"
            >
              <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">{meta}</div>
                {open ? (
                  <ChevronDown
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <ChevronRight
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                )}
              </div>
              <p
                className={
                  open
                    ? "mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground"
                    : "mt-0.5 line-clamp-1 text-xs text-muted-foreground"
                }
              >
                {s.stance}
              </p>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SideMeta({ s }: { s: TeamPreviewSideView }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <p className="min-w-0 text-xs font-medium text-foreground">{s.name}</p>
      {s.is_subject && (
        <span className="text-xs text-muted-foreground">方案方</span>
      )}
    </div>
  );
}
