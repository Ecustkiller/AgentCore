import { Markdown } from "@/components/chat/Markdown";
import { hasDebriefDetails } from "@/components/chat/handoffBrief";
import { Button } from "@/components/ui";
import type { MotionCard, RunDebrief } from "@/types/events";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Section } from "./shared";

const FORM_LABEL: Record<MotionCard["form"], string> = {
  debate: "正反",
  red_team: "红队",
  roundtable: "圆桌",
};

const DEGRADED_NOTICE = "简报由系统降级生成";

/**
 * Live SSE carries `degraded` as an extra dict key on the debrief object
 * (`synthesize_debrief`). It is not on the `RunDebrief` wire type — read it
 * here, do not widen the contract.
 */
function isDegradedDebrief(debrief: RunDebrief): boolean {
  return (
    "degraded" in debrief &&
    (debrief as { degraded?: unknown }).degraded === true
  );
}

/**
 * 完工交接简报 (run_completed.debrief) — the worker's OWN structured wrap-up.
 * Defaults to a collapsed relay card (title row = `summary`); expand to read
 * 要点 / 假设 / 下一步 / 命题卡. Engine-synthesized (`degraded`) briefs show a
 * notice only — their summary is a 200-char slice of the body already above.
 */
export function DebriefSection({ debrief }: { debrief: RunDebrief }) {
  const degraded = isDegradedDebrief(debrief);
  const details = !degraded && hasDebriefDetails(debrief);
  const [open, setOpen] = useState(false);
  const summary = debrief.summary?.trim() ?? "";

  return (
    <Section title="交接简报">
      <div className="space-y-3 rounded-lg bg-muted p-3">
        {degraded ? (
          <p className="text-sm text-muted-foreground">{DEGRADED_NOTICE}</p>
        ) : details ? (
          <>
            <Button
              variant="ghost"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="h-auto w-full justify-start gap-2 px-0 py-0 hover:bg-transparent"
            >
              <span className="flex w-full items-start gap-2 text-left">
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
                <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm text-foreground">
                  {summary || "交接简报"}
                </span>
              </span>
            </Button>
            {open && <DebriefDetails debrief={debrief} />}
          </>
        ) : summary ? (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {summary}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

export function DebriefDetails({ debrief }: { debrief: RunDebrief }) {
  const { key_points, assumptions, next_steps, motion_card } = debrief;
  return (
    <div className="space-y-3">
      {key_points && key_points.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            关键要点
          </p>
          <ul className="list-disc space-y-0.5 pl-4 text-sm text-foreground">
            {key_points.map((pt, i) => (
              <li key={`${i}:${pt}`}>{pt}</li>
            ))}
          </ul>
        </div>
      )}
      {assumptions && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            关键假设
          </p>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {assumptions}
          </p>
        </div>
      )}
      {next_steps && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            建议下一步
          </p>
          <Markdown content={next_steps} />
        </div>
      )}
      {motion_card && <MotionCardBlock card={motion_card} />}
    </div>
  );
}

function MotionCardBlock({ card }: { card: MotionCard }) {
  const formLabel = FORM_LABEL[card.form] ?? card.form;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">命题卡</p>
      <div className="space-y-2">
        <div>
          <p className="mb-0.5 text-xs text-muted-foreground">命题</p>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {card.motion}
          </p>
        </div>
        {card.sides.length > 0 && (
          <div>
            <p className="mb-0.5 text-xs text-muted-foreground">双方</p>
            <ul className="list-disc space-y-0.5 pl-4 text-sm text-foreground">
              {card.sides.map((side) => (
                <li key={side.key}>
                  <span className="font-medium">{side.name}</span>
                  <span className="text-muted-foreground"> · </span>
                  {side.stance}
                </li>
              ))}
            </ul>
          </div>
        )}
        {card.fact_pointers.length > 0 && (
          <div>
            <p className="mb-0.5 text-xs text-muted-foreground">依据指针</p>
            <ul className="list-disc space-y-0.5 pl-4 font-mono text-sm text-foreground">
              {card.fact_pointers.map((ptr, i) => (
                <li key={`${i}:${ptr}`}>{ptr}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="mb-0.5 text-xs text-muted-foreground">为何需对抗</p>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {card.rationale}
          </p>
        </div>
        <div>
          <p className="mb-0.5 text-xs text-muted-foreground">形式</p>
          <p className="text-sm text-foreground">{formLabel}</p>
        </div>
      </div>
    </div>
  );
}
