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
  DebateRoundInfo,
} from "@agentcore/contract-types";
import type { ReactNode } from "react";

const FORM_LABEL: Record<DebateResultPayload["form"], string> = {
  debate: "正反辩论",
  red_team: "红队审查",
  roundtable: "圆桌探讨",
};

/** 辩论收场原因 → 中文 (镜像后端 STOP_REASONS，与桌面 STOP_LABELS 同文；跨端各自一份、文案对齐)。
 *  权威词表见 `runtime/debate/types.py` 的 STOP_REASONS。识别不到的原样渲染。 */
const STOP_LABEL: Record<string, string> = {
  converged: "已收敛",
  focus_clarified: "已澄清为价值之争",
  red_team_exhausted: "风险已挖尽",
  max_rounds: "达轮次上限",
  all_failed: "发言失败提前终止",
  user_concluded: "你叫停出结论",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** model id（`provider/model` 或无前缀）→ 友好厂商名（真·多模型辩论的「谁是哪个模型」展示）。
 *  手机端自带一份（cross-platform：各端全新建、不共享业务逻辑）。空 → null（不显模型标）。 */
function modelVendorLabel(model: string | undefined): string | null {
  const m = (model ?? "").trim();
  if (!m) return null;
  const byPrefix: Record<string, string> = {
    doubao: "豆包",
    kimi: "Kimi",
    zhipu: "智谱",
    deepseek: "DeepSeek",
  };
  const prefix = m.includes("/") ? m.slice(0, m.indexOf("/")) : "";
  if (prefix) return byPrefix[prefix] ?? prefix;
  if (/^deepseek/i.test(m)) return "DeepSeek";
  if (/^doubao/i.test(m)) return "豆包";
  if (/^glm/i.test(m)) return "智谱";
  if (/^kimi/i.test(m)) return "Kimi";
  return m;
}

export function DebateView({ debate }: { debate: DebateResultPayload }) {
  const brief = <Brief debate={debate} />;
  const narrative = <Narrative debate={debate} />;
  return (
    <div className="debate">
      <div className="debate-head">
        <span className="debate-title">主持人终审</span>
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
        {debate.sides.map((s) => {
          const vendor = modelVendorLabel(s.model);
          return (
            <div key={s.key} className="debate-point">
              <span className="debate-point-head">
                <span className="debate-point-name">{s.name}</span>
                {vendor && <span className="debate-point-model">{vendor}</span>}
              </span>
              <span className="debate-point-text">
                {b.strongest_points[s.key] ?? "—"}
              </span>
            </div>
          );
        })}
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
            <ModeratorSummary summary={r.summary} />
            <RoundClashes round={r} />
            <RoundInterjections round={r} />
          </div>
        ))}
      </div>
    </details>
  );
}

/** 主持人小结 —— 逐轮小结由主持人（中立裁判）给出，用一枚「主持人」小标记明确作者身份（桌面端是
 *  法槌头像 + 发言气泡，手机端精简为小标记 + 文本）。空小结不渲染。 */
function ModeratorSummary({ summary }: { summary: string }) {
  if (!summary) return null;
  return (
    <div className="debate-round-summary">
      <span className="debate-round-no">主持人</span> {summary}
    </div>
  );
}

/** 本轮「你的追问」(辩论编排设计.md §6.3)：向谁问 + 问题原文 +
 *  是否被承接。`answered` 是结构事实（是否真有后续轮跑起来答它，追问即续辩则恒真），非「答得好不好」。
 *  仅收场 {@link DebateRoundInfo} 携带（live 孪生 {@link DebateNarrativeRound} 不带）；无追问 → 不渲染。
 *  手机端只读复盘——逐轮决策 / 追问输入是桌面端能力（手机无掌舵卡）。 */
function RoundInterjections({ round }: { round: DebateRoundInfo }) {
  const items = round.user_interjections ?? [];
  if (items.length === 0) return null;
  const nameOf = (key: string) =>
    round.sides.find((s) => s.key === key)?.name ?? key;
  return (
    <ul className="debate-asks">
      {items.map((it, i) => (
        <li key={`${it.ask}-${i}`} className="debate-ask">
          <span className="debate-ask-edge">
            {it.target_key ? `向 ${nameOf(it.target_key)}` : "向全场"}
          </span>
          <span className="debate-ask-text">{it.ask}</span>
          <span className={`debate-ask-state${it.answered ? " ask-ok" : ""}`}>
            {it.answered ? "已回应" : "未及回应"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** L3 论点级交锋边（谁驳谁）：把本轮裁判抽取的针对性反驳渲染成「来源方 → 被驳方  要点」列表。
 *  `from_key`/`to_key` 是语义 side key，据本轮 `sides` 解析成展示名（解析不到则原样退化）。
 *  收场与进行中两路同构（{@link DebateRoundInfo} / {@link DebateNarrativeRound} 都带 `clashes`）。 */
function RoundClashes({
  round,
}: {
  round: DebateRoundInfo | DebateNarrativeRound;
}) {
  if (round.clashes.length === 0) return null;
  const nameOf = (key: string) =>
    round.sides.find((s) => s.key === key)?.name ?? key;
  return (
    <ul className="debate-clashes">
      {round.clashes.map((c, i) => (
        <li key={`${c.from_key}-${c.to_key}-${i}`} className="debate-clash">
          <span className="debate-clash-edge">
            {nameOf(c.from_key)} → {nameOf(c.to_key)}
          </span>
          <span className="debate-clash-point">{c.point}</span>
        </li>
      ))}
    </ul>
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
            <ModeratorSummary summary={r.summary} />
            <RoundClashes round={r} />
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
