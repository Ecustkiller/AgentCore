// 辩论双产物的移动端精简视图 (辩论编排设计.md「双产物」), rendered under the team list.
//
// A phone-native reduction of the desktop DebateProducts: the 决策简报 (倾向/置信/争点/
// 各方最强论点/分歧/建议/待解) over a collapsed 交锋叙事线 (逐轮 焦点 + 裁判 + 小结).
// `narrative_first` flips their order (exploratory roundtable leads with the process, a
// decision debate with the conclusion). The per-side full speeches (L3) are NOT repeated
// here — they already live as each debater's RunCard preview in the team list above (one
// source, phone-sized). Consumed identically by live turns and history replay off the same
// ProjectedTurn.debate (fold) — no second data path.
import type {
  DebateNarrativeRound,
  DebateResultPayload,
} from "@agentcore/contract-types";
import type { ReactNode } from "react";

const FORM_LABEL: Record<DebateResultPayload["form"], string> = {
  debate: "正反辩论",
  red_team: "红队审查",
  roundtable: "圆桌探讨",
};

/** 辩论收场原因 → 中文 (后端 DebateResult.stop_reason). Unknown reasons render raw. */
const STOP_LABEL: Record<string, string> = {
  converged: "已收敛",
  max_rounds: "达轮次上限",
  unproductive: "无新进展",
  degraded: "质量下降",
  error: "异常中止",
  cancelled: "已停止",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export function DebateView({ debate }: { debate: DebateResultPayload }) {
  const brief = <Brief debate={debate} />;
  const narrative = <Narrative debate={debate} />;
  return (
    <div className="debate">
      <div className="debate-head">
        <span className="debate-title">辩论结论</span>
        <span className="debate-tag">{FORM_LABEL[debate.form] ?? "辩论"}</span>
        <span className="debate-stop">
          {STOP_LABEL[debate.stop_reason] ?? debate.stop_reason}
        </span>
      </div>
      {debate.narrative_first ? (
        <>
          {narrative}
          {brief}
        </>
      ) : (
        <>
          {brief}
          {narrative}
        </>
      )}
    </div>
  );
}

/** 决策简报 (结论): 倾向 + 置信 up top, then 争点 / 各方最强论点 / 分歧 / 建议 / 待解.
 *  Empty sections are omitted (honest gaps). */
function Brief({ debate }: { debate: DebateResultPayload }) {
  const b = debate.brief;
  const conf = CONFIDENCE_LABEL[b.confidence] ?? b.confidence;
  return (
    <div className="debate-brief">
      <div className="debate-leaning">
        <span className="debate-leaning-text">{b.leaning}</span>
        <span className={`debate-conf conf-${b.confidence}`}>置信 {conf}</span>
      </div>
      <Field label="关键争点">{b.crux}</Field>
      <div className="debate-points">
        {debate.sides.map((s) => (
          <div key={s.key} className="debate-point">
            <span className="debate-point-name">{s.name}</span>
            <span className="debate-point-text">
              {b.strongest_points[s.key] ?? "—"}
            </span>
          </div>
        ))}
      </div>
      {b.factual_disputes.length > 0 && (
        <ListField label="事实分歧" items={b.factual_disputes} />
      )}
      {b.value_disputes.length > 0 && (
        <ListField label="价值分歧" items={b.value_disputes} />
      )}
      <Field label="建议">{b.recommendation}</Field>
      {b.open_questions.length > 0 && (
        <ListField label="待解问题" items={b.open_questions} />
      )}
    </div>
  );
}

/** 交锋叙事线 (process), collapsed by default — secondary to the conclusion. Each round is
 *  焦点 + 裁判徽章 + 主持人小结; the full speeches stay in the team list above. */
function Narrative({ debate }: { debate: DebateResultPayload }) {
  if (debate.rounds.length === 0) return null;
  return (
    <details className="debate-narrative">
      <summary>交锋叙事线 · {debate.rounds.length} 轮</summary>
      <div className="debate-rounds">
        {debate.rounds.map((r) => (
          <div key={r.round_no} className="debate-round">
            <div className="debate-round-head">
              <span className="debate-round-no">第 {r.round_no} 轮</span>
              <span className="debate-round-focus">{r.focus}</span>
            </div>
            <div className="debate-verdict">
              <span className="debate-vpill">
                {r.verdict.real_clash ? "有交锋" : "各说各话"}
              </span>
              <span className="debate-vpill">
                {r.verdict.new_arguments ? "有新论据" : "无新论据"}
              </span>
              {r.verdict.converged && (
                <span className="debate-vpill vpill-ok">已收敛</span>
              )}
            </div>
            {r.summary && (
              <div className="debate-round-summary">{r.summary}</div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/** 辩论进行中的逐轮叙事 (live) —— 逐轮增量事件 (`debate_round_started` / `debate_round`) 折叠
 *  出的 {@link DebateNarrativeRound}：每轮发言前先亮焦点，裁判 + 小结在发言后补上 (verdict=null
 *  = 该轮仍在进行)。各方发言全文不在此 (已是上方团队列表里各辩手的 RunCard)，故只铺主持人的逐
 *  轮编排。收场后由 {@link DebateView} 的全量双产物接管 (届时 `debate` 在手，本视图不再渲染)。 */
export function LiveDebateNarrative({
  rounds,
}: {
  rounds: DebateNarrativeRound[];
}) {
  if (rounds.length === 0) return null;
  return (
    <div className="debate">
      <div className="debate-head">
        <span className="debate-title">辩论进行中</span>
        <span className="debate-tag">{rounds.length} 轮</span>
      </div>
      <div className="debate-rounds">
        {rounds.map((r) => (
          <div key={r.round_no} className="debate-round">
            <div className="debate-round-head">
              <span className="debate-round-no">第 {r.round_no} 轮</span>
              <span className="debate-round-focus">{r.focus}</span>
            </div>
            {r.verdict && (
              <div className="debate-verdict">
                <span className="debate-vpill">
                  {r.verdict.real_clash ? "有交锋" : "各说各话"}
                </span>
                <span className="debate-vpill">
                  {r.verdict.new_arguments ? "有新论据" : "无新论据"}
                </span>
                {r.verdict.converged && (
                  <span className="debate-vpill vpill-ok">已收敛</span>
                )}
              </div>
            )}
            {r.summary && (
              <div className="debate-round-summary">{r.summary}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="debate-field">
      <span className="debate-field-label">{label}</span>
      <span className="debate-field-value">{children}</span>
    </div>
  );
}

function ListField({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="debate-field">
      <span className="debate-field-label">{label}</span>
      <ul className="debate-list">
        {items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
