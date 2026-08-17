import { Markdown } from "@/components/Markdown";
import type { RunDebrief } from "@agentcore/protocol-conformance";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

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

function hasDebriefDetails(debrief: RunDebrief): boolean {
  return Boolean(
    (debrief.key_points && debrief.key_points.length > 0) ||
      debrief.assumptions ||
      debrief.next_steps,
  );
}

/**
 * 完工交接简报 (run_completed.debrief) — the worker's OWN structured wrap-up.
 * Defaults to a collapsed relay card (title row = `summary`); expand to read
 * 要点 / 假设 / 下一步. Engine-synthesized (`degraded`) briefs show a notice
 * only — their summary is a 200-char slice of the body already above.
 */
export function DebriefBlock({ debrief }: { debrief: RunDebrief }) {
  const degraded = isDegradedDebrief(debrief);
  const details = !degraded && hasDebriefDetails(debrief);
  const [open, setOpen] = useState(false);
  const summary = debrief.summary?.trim() ?? "";

  return (
    <section className="rd-section">
      <h4 className="rd-section-title">交接简报</h4>
      <div className="rd-debrief">
        {degraded ? (
          <p className="rd-debrief-notice">{DEGRADED_NOTICE}</p>
        ) : details ? (
          <>
            <button
              type="button"
              className="rd-debrief-toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? (
                <ChevronDown size={14} className="rd-debrief-chevron" />
              ) : (
                <ChevronRight size={14} className="rd-debrief-chevron" />
              )}
              <span className="rd-debrief-summary">
                {summary || "交接简报"}
              </span>
            </button>
            {open && <DebriefDetails debrief={debrief} />}
          </>
        ) : summary ? (
          <p className="rd-debrief-summary">{summary}</p>
        ) : null}
      </div>
    </section>
  );
}

function DebriefDetails({ debrief }: { debrief: RunDebrief }) {
  const { key_points, assumptions, next_steps } = debrief;
  return (
    <div className="rd-debrief-details">
      {key_points && key_points.length > 0 && (
        <div className="rd-debrief-part">
          <div className="rd-part-label">关键要点</div>
          <ul className="rd-points">
            {key_points.map((pt, i) => (
              <li key={`${i}:${pt}`}>{pt}</li>
            ))}
          </ul>
        </div>
      )}
      {assumptions && (
        <div className="rd-debrief-part">
          <div className="rd-part-label">关键假设</div>
          <p className="rd-assume">{assumptions}</p>
        </div>
      )}
      {next_steps && (
        <div className="rd-debrief-part">
          <div className="rd-part-label">建议下一步</div>
          <Markdown content={next_steps} evidence />
        </div>
      )}
    </div>
  );
}
