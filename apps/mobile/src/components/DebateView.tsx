// 辩论双产物的移动端视图 (辩论编排设计.md「双产物」), rendered under the team list.
//
// Phone-native reduction of desktop DebateProducts / DebateProgressLine: 决策简报
// (倾向/置信/争点/各方最强论点/分歧/建议/待解) over a collapsible 交锋叙事线
// (逐轮 焦点 + 裁判 + 小结). `narrative_first` flips their order. Per-side full
// speeches stay on RunCards in the team list above. No desktop import; no canvas CTA.
import { Markdown } from "@/components/Markdown";
import type {
  DebateHandoffInfo,
  DebateNarrativeRound,
  DebateResultPayload,
  DebateRoundInfo,
} from "@agentcore/contract-types";
import { type ReactNode, useState } from "react";
import "./DebateView.css";

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

/** Phase 3 最小对齐：有 model 才出三方署名；无字段零噪声。 */
function vendorLabel(model: string | null | undefined): string | null {
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

function formatDebateRosterLine(debate: DebateResultPayload): string | null {
  const hasAny =
    debate.sides.some((s) => Boolean((s.model ?? "").trim())) ||
    Boolean((debate.moderator_model ?? "").trim());
  if (!hasAny) return null;
  const parts: string[] = [];
  for (const s of debate.sides) {
    const label = vendorLabel(s.model);
    if (!label) continue;
    parts.push(`${s.name} ${s.origin === "byok" ? `${label}·BYOK` : label}`);
  }
  const mod = vendorLabel(debate.moderator_model);
  if (mod) {
    parts.push(
      `裁判 ${debate.moderator_origin === "byok" ? `${mod}·BYOK` : mod}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

type HandoffKind = "value" | "fact" | "question";

function asHandoffKind(raw: string): HandoffKind {
  return raw === "value" || raw === "fact" || raw === "question"
    ? raw
    : "question";
}

function formatRoundHint(round: {
  round_no: number;
  focus: string;
  summary: string;
  inFlight?: boolean;
}): string {
  const label = round.round_no > 0 ? `第 ${round.round_no} 轮` : "本场";
  if (round.inFlight && !round.focus) return `${label} · 进行中`;
  if (round.focus && round.summary) {
    return `${label} · ${round.focus} · ${round.summary}`;
  }
  if (round.focus) return `${label} · ${round.focus}`;
  if (round.summary) return `${label} · ${round.summary}`;
  return label;
}

export function DebateView({
  debate,
  onFill,
}: {
  debate: DebateResultPayload;
  /** 有则展示「回复拍板 / 派查证」并回填 composer；只读上下文省略。 */
  onFill?: (text: string) => void;
}) {
  const brief = <Brief debate={debate} onFill={onFill} />;
  const narrative = <Narrative debate={debate} />;
  const rosterLine = formatDebateRosterLine(debate);
  const opening = (debate.opening ?? "").trim();
  return (
    <div className="debate" data-testid="debate-view">
      <div className="debate-head">
        <span className="debate-title">主持人终审</span>
        <span className="debate-tag">{FORM_LABEL[debate.form] ?? "辩论"}</span>
        <span className="debate-stop">
          {STOP_LABEL[debate.stop_reason] ?? debate.stop_reason}
        </span>
      </div>
      {debate.motion.trim() ? (
        <p className="debate-motion">
          <span className="debate-motion-label">辩题 · </span>
          {debate.motion.trim()}
        </p>
      ) : null}
      {rosterLine && (
        <div className="debate-field" data-testid="debate-roster-line">
          <span className="debate-field-value">{rosterLine}</span>
        </div>
      )}
      {opening ? <p className="debate-opening">{opening}</p> : null}
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

/** 决策简报 (结论): 倾向 + 置信 up top, then 争点 / 各方最强论点 / 留给你的 / 建议。
 *  Empty sections are omitted (honest gaps). */
function Brief({
  debate,
  onFill,
}: {
  debate: DebateResultPayload;
  onFill?: (text: string) => void;
}) {
  const b = debate.brief;
  const conf = CONFIDENCE_LABEL[b.confidence] ?? b.confidence;
  const decisive = (b.decisive ?? "").trim();
  return (
    <div className="debate-brief">
      <div className="debate-brief-kicker">裁决</div>
      <div className="debate-leaning">
        <span className="debate-leaning-text">{b.leaning}</span>
        <span className={`debate-conf conf-${b.confidence}`}>置信 {conf}</span>
      </div>
      {decisive ? <Field label="关键依据">{decisive}</Field> : null}
      <Field label="关键争点">{b.crux}</Field>
      <div className="debate-points">
        {debate.sides.map((s) => (
          <div key={s.key} className="debate-point">
            <span className="debate-point-head">
              <span className="debate-point-name">{s.name}</span>
            </span>
            <span className="debate-point-text">
              {b.strongest_points[s.key] ?? "—"}
            </span>
          </div>
        ))}
      </div>
      <HandoffsBlock items={b.handoffs ?? []} onFill={onFill} />
      <Field label="建议">
        <Markdown content={b.recommendation} muted />
      </Field>
    </div>
  );
}

/**
 * 「留给你的」：按 kind 三种异质形态——
 * value 问句卡 / fact 查证任务行 / question 脚注；旧分类名词退场。
 */
function HandoffsBlock({
  items,
  onFill,
}: {
  items: DebateHandoffInfo[];
  onFill?: (text: string) => void;
}) {
  if (items.length === 0) return null;
  const normalized = items.map((h) => ({
    kind: asHandoffKind(h.kind),
    text: h.text,
  }));
  const values = normalized.filter((h) => h.kind === "value");
  const facts = normalized.filter((h) => h.kind === "fact");
  const questions = normalized.filter((h) => h.kind === "question");
  return (
    <div className="debate-handoffs">
      <div className="debate-handoffs-title">留给你的</div>
      {values.map((h) => {
        // 问号兜底仅当末尾无终结标点（历史数据是「。」收尾的陈述句，别拼成「。？」）。
        const mark = /[？?。！!…]$/.test(h.text) ? "" : "？";
        return (
          <div key={h.text} className="debate-handoff-value">
            <p className="debate-handoff-value-text">
              {h.text}
              {mark}
            </p>
            {onFill && (
              <button
                type="button"
                className="debate-handoff-action"
                onClick={() => onFill(`关于「${h.text}」，我的取舍是：`)}
              >
                回复拍板
              </button>
            )}
          </div>
        );
      })}
      {facts.length > 0 && (
        <ul className="debate-handoff-facts">
          {facts.map((h) => (
            <li key={h.text} className="debate-handoff-fact">
              <span className="debate-handoff-fact-text">{h.text}</span>
              {onFill && (
                <button
                  type="button"
                  className="debate-handoff-action debate-handoff-action-muted"
                  onClick={() => onFill(`帮我查证：${h.text}`)}
                >
                  派查证
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {questions.length > 0 && (
        <p className="debate-handoff-footnote">
          只能等的：{questions.map((h) => h.text).join("；")}
        </p>
      )}
    </div>
  );
}

/** 交锋叙事线 (process), collapsed by default — secondary to the conclusion. Each round is
 *  焦点 + 裁判徽章 + 主持人小结; the full speeches stay in the team list above. */
function Narrative({ debate }: { debate: DebateResultPayload }) {
  if (debate.rounds.length === 0) return null;
  const latest = debate.rounds[debate.rounds.length - 1];
  const hint = formatRoundHint({
    round_no: latest.round_no,
    focus: latest.focus,
    summary: latest.summary,
  });
  return (
    <details className="debate-narrative">
      <summary>
        <span className="debate-progress-chevron" aria-hidden />
        <span className="debate-progress-badge">
          交锋叙事 · {debate.rounds.length} 轮
        </span>
        <span className="debate-progress-hint">{hint}</span>
      </summary>
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
            <RoundWitnessExam round={r} />
            <RoundInterjections round={r} />
          </div>
        ))}
      </div>
    </details>
  );
}

/** 批 D1 · 证人答问：主持人点名幕1 透镜证人的事实性问答摘要。 */
function RoundWitnessExam({ round }: { round: DebateRoundInfo }) {
  const items = round.witness_exam ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="debate-asks">
      {items.map((wx) => (
        <li key={wx.witness_key} className="debate-ask">
          <span className="debate-ask-edge">
            {wx.name}
            {wx.origin_caption ? ` · ${wx.origin_caption}` : ""}
          </span>
          <span className="debate-ask-text">
            {(wx.exchanges ?? [])
              .map(
                (ex) =>
                  `问：${ex.question}${ex.answer ? ` / 答：${ex.answer}` : ""}`,
              )
              .join("；")}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 主持人小结 —— 逐轮小结由主持人（中立裁判）给出。空小结不渲染。 */
function ModeratorSummary({ summary }: { summary: string }) {
  if (!summary) return null;
  return (
    <p className="debate-round-summary-line">
      <strong>小结 · </strong>
      {summary}
    </p>
  );
}

/** 本轮「你的追问」(辩论编排设计.md §6.3)：向谁问 + 问题原文 +
 *  是否被承接。手机端只读复盘——逐轮决策 / 追问输入是桌面端能力。 */
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

/** L3 论点级交锋边（谁驳谁）：把本轮裁判抽取的针对性反驳渲染成「来源方 → 被驳方  要点」列表。 */
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

/** 辩论进行中的逐轮叙事 (live) —— 对齐桌面 DebateProgressLine：折叠看最新焦点，展开看全轮。
 *  收场后由 {@link DebateView} 的全量双产物接管。 */
export function LiveDebateNarrative({
  rounds,
}: {
  rounds: DebateNarrativeRound[];
}) {
  const live = rounds.some((r) => r.verdict == null);
  const [expanded, setExpanded] = useState(live);
  if (rounds.length === 0) return null;
  const latest = rounds[rounds.length - 1];
  const inFlight = latest.verdict == null;
  const hint = formatRoundHint({
    round_no: latest.round_no,
    focus: latest.focus,
    summary: latest.summary,
    inFlight,
  });
  return (
    <div className="debate" data-testid="live-debate-narrative">
      <div className="debate-head">
        <span className="debate-title">辩论进行中</span>
        <span className="debate-tag">{rounds.length} 轮</span>
      </div>
      <div className="debate-progress">
        <button
          type="button"
          className="debate-progress-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "收起推进线" : "展开推进线"}
        >
          <span className="debate-progress-chevron" aria-hidden>
            {expanded ? "▾" : "▸"}
          </span>
          <span className="debate-progress-badge">推进线 {rounds.length}</span>
          {!expanded && <span className="debate-progress-hint">{hint}</span>}
        </button>
        {expanded && (
          <ol className="debate-rounds">
            {rounds.map((r) => {
              const roundLive = r.verdict == null;
              return (
                <li key={r.round_no} className="debate-round">
                  <div className="debate-round-head">
                    <span className="debate-round-no">第 {r.round_no} 轮</span>
                    {roundLive && (
                      <span className="debate-round-live">进行中</span>
                    )}
                  </div>
                  {r.focus ? (
                    <p className="debate-round-focus">
                      <span className="debate-motion-label">焦点 · </span>
                      {r.focus}
                    </p>
                  ) : roundLive ? (
                    <p className="debate-round-focus-muted">等待焦点…</p>
                  ) : null}
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
                  {r.summary ? (
                    <p className="debate-round-summary-line">
                      <strong>小结 · </strong>
                      {r.summary}
                    </p>
                  ) : null}
                  <RoundClashes round={r} />
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="debate-field">
      <span className="debate-field-label">{label}</span>
      <div className="debate-field-value">{children}</div>
    </div>
  );
}
