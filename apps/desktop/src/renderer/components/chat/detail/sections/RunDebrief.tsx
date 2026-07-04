import { Markdown } from "@/components/chat/Markdown";
import type { RunDebrief } from "@/types/events";
import { Section } from "./shared";

/**
 * 完工交接简报 (run_completed.debrief) — the worker's OWN structured wrap-up, surfaced in
 * place of the old head-truncated「摘要」. Renders only the sections the worker authored
 * (结论 / 关键要点 / 关键假设 / 建议下一步); a worker that wrote none falls back to its full
 * 输出 above (this component isn't rendered). This is the deliberate 退休截断 — the summary
 * is authored, never a machine slice of prose.
 */
export function DebriefSection({ debrief }: { debrief: RunDebrief }) {
  const { summary, key_points, assumptions, next_steps } = debrief;
  return (
    <Section title="交接简报">
      <div className="space-y-3 rounded-lg bg-muted p-3">
        {summary && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              结论
            </p>
            <Markdown content={summary} />
          </div>
        )}
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
      </div>
    </Section>
  );
}
