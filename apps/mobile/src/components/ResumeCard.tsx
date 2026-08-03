import type { TeamPreviewAmendments } from "@/api/stream";
import type { PausedTurnSummary } from "@/api/turn";
import {
  BrowserLoginDecisionCard,
  type BrowserLoginSubmitKind,
} from "@/components/BrowserLoginDecisionCard";
import { composeAnswer } from "@/components/ask/composeAnswer";
import {
  RISK_SEVERITY_TAG,
  parseRiskLabel,
} from "@/components/ask/parseRiskLabel";
// Durable resume card — the actionable surface for a turn that paused at a checkpoint then
// lost its live stream (结构化挂起 2b). Unlike PauseCard (which settles a LIVE fold
// `interactions[]` over the still-open SSE via resolveInteraction), this reads a
// PERSISTED PausedTurnSummary (no assistant message yet, only a frame) and asks the parent
// to drive a fresh resume stream (api/stream.ts::resumeStream).
//
// Mobile's own UI (cross-platform-frontend.mdc). ask_user intent 专用面：
// organize_plan / daily_review 勾选墙；proposal_pick 行式单选；risk_ack 行式多选；
// decision/kickoff = default 预选 + compose 答复模型 +「其他」逃逸（本机目录 action 不做）。
// Delegate team_preview：纳入开关 + 写盘单向收紧（开工组队有限否决 · 块 C）。
// ask_user + browser_login → BrowserLoginDecisionCard（冷路登录卡；可开 BrowserLiveSheet）。
import type { CheckpointDecision } from "@agentcore/contract-types";
import { useState } from "react";

function str(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === "string" && v.trim() ? v : null;
}

function asRecords(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v)
    ? v.filter(
        (x): x is Record<string, unknown> =>
          !!x && typeof x === "object" && !Array.isArray(x),
      )
    : [];
}

/** Flatten ask_user option labels (bare string or `{label}`) for resume `selected`. */
function optionLabel(o: unknown): string {
  if (typeof o === "string") return o.trim();
  if (o && typeof o === "object" && !Array.isArray(o)) {
    return str(o as Record<string, unknown>, "label") ?? "";
  }
  return "";
}

/** Phase 3 最小对齐：有 model 才出「正方 X · 反方 Y · 裁判 Z」；无字段零噪声。 */
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

function formatDebateRosterLine(
  sides: Array<{ name?: string; model?: string; origin?: string }>,
  moderatorModel?: string | null,
  moderatorOrigin?: string | null,
): string | null {
  const hasAny =
    sides.some((s) => Boolean((s.model ?? "").trim())) ||
    Boolean((moderatorModel ?? "").trim());
  if (!hasAny) return null;
  const parts: string[] = [];
  for (const s of sides) {
    const label = vendorLabel(s.model);
    if (!label || !s.name) continue;
    parts.push(`${s.name} ${s.origin === "byok" ? `${label}·BYOK` : label}`);
  }
  const mod = vendorLabel(moderatorModel);
  if (mod) {
    parts.push(`裁判 ${moderatorOrigin === "byok" ? `${mod}·BYOK` : mod}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

const REVIEW_KIND_LABEL: Record<string, string> = {
  preference: "偏好",
  profile: "画像",
  topic: "主题",
  rule: "规则",
  doc: "文档",
};

function reviewOptionDetail(o: Record<string, unknown>): string | undefined {
  const kindRaw = str(o, "review_kind");
  const kind = kindRaw ? REVIEW_KIND_LABEL[kindRaw] : undefined;
  const summary = (str(o, "body") ?? str(o, "detail") ?? "").trim();
  if (kind && summary) return `${kind} · ${summary}`;
  if (kind) return kind;
  return summary || undefined;
}

function organizeOptionDetail(o: Record<string, unknown>): string | undefined {
  const op = str(o, "op");
  if (op === "move" || op === "copy") {
    return `${str(o, "source") ?? "?"} → ${str(o, "destination") ?? "?"}`;
  }
  const path = str(o, "path");
  if (path) return `${op ?? "op"} ${path}`;
  return str(o, "detail") ?? undefined;
}

/** Seed every choice label (mirrors desktop useAskAnswer seedAllMultiple). */
function seedAllMultipleAnswers(
  questions: Array<Record<string, unknown>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const q of questions) {
    const id = str(q, "id") ?? str(q, "prompt") ?? "";
    if (!id) continue;
    const options = Array.isArray(q.options) ? q.options : [];
    out[id] = options.map(optionLabel).filter(Boolean);
  }
  return out;
}

/** Seed each question's `default` (decision / proposal / risk). */
function seedDefaultAnswers(
  questions: Array<Record<string, unknown>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const q of questions) {
    const id = str(q, "id") ?? str(q, "prompt") ?? "";
    if (!id) continue;
    const def = str(q, "default");
    out[id] = def ? [def] : [];
  }
  return out;
}

function pickedCount(answers: Record<string, string[]>): number {
  let n = 0;
  for (const labels of Object.values(answers)) n += labels.length;
  return n;
}

function isDesktopFolderAction(action: string | null | undefined): boolean {
  return (
    action === "open_local_project" ||
    action === "bind_local_folder" ||
    action === "grant_readonly_folder" ||
    action === "grant_organize_folder"
  );
}

type PreviewWorker = {
  run_id: string;
  role: string;
  task: string;
  depends_on: string[];
  write_capability: "text_only" | "can_write_files" | null;
  write_capability_label: string | null;
};

function parseDependsOn(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && !!x.trim());
}

function parseWriteCapability(
  w: Record<string, unknown>,
): "text_only" | "can_write_files" | null {
  const cap = str(w, "write_capability");
  if (cap === "text_only" || cap === "can_write_files") return cap;
  const form = str(w, "form");
  if (form === "prose") return "text_only";
  if (form === "files") return "can_write_files";
  return null;
}

/** Parse delegate team_preview worker rows (run_id required for amend controls). */
export function parseTeamPreviewWorkers(
  raw: Array<Record<string, unknown>> | undefined,
): PreviewWorker[] {
  const out: PreviewWorker[] = [];
  for (const w of raw ?? []) {
    const run_id = str(w, "run_id");
    if (!run_id) continue;
    out.push({
      run_id,
      role: str(w, "role") ?? "",
      task: str(w, "task") ?? "",
      depends_on: parseDependsOn(w.depends_on),
      write_capability: parseWriteCapability(w),
      write_capability_label: str(w, "write_capability_label"),
    });
  }
  return out;
}

/** Intents whose continue settle carries `selected` (mirrors desktop CheckpointCard). */
const CARRIES_SELECTED = new Set([
  "proposal_pick",
  "risk_ack",
  "organize_plan",
  "daily_review",
]);

/** Intents with row checkbox wall (default all on; uncheck = skip/exclude). */
const CHECKBOX_WALL = new Set(["daily_review", "organize_plan"]);

export function ResumeCard({
  paused,
  onResume,
  onOpenLive,
}: {
  paused: PausedTurnSummary;
  onResume: (
    decision: CheckpointDecision,
    note: string,
    selected: string[],
    amendments?: TeamPreviewAmendments,
  ) => void;
  /** Open BrowserLiveSheet from cold-path browser_login card. */
  onOpenLive?: () => void;
}) {
  const isPlanReview = paused.kind === "plan_review";
  const isTeamPreview = paused.kind === "team_preview";
  const isAskUser =
    paused.kind === "ask_user" || (!isPlanReview && !isTeamPreview);

  // Cold-path browser_login: dedicated login card (mirrors desktop AskUserBrowserLoginResumeCard).
  if (isAskUser && paused.browser_login === true) {
    return (
      <AskUserBrowserLoginResumeCard
        paused={paused}
        onResume={onResume}
        onOpenLive={onOpenLive}
      />
    );
  }

  return (
    <ResumeCardBody
      paused={paused}
      onResume={onResume}
      isPlanReview={isPlanReview}
      isTeamPreview={isTeamPreview}
      isAskUser={isAskUser}
    />
  );
}

/** CEO ask_user(browser_login)：continue note 固定「已登录，继续」；次钮 stop（勿「跳过」）；
 * 有 assumptions →「按假设继续」（冷路 continue + note=假设文案）。 */
function AskUserBrowserLoginResumeCard({
  paused,
  onResume,
  onOpenLive,
}: {
  paused: PausedTurnSummary;
  onResume: (
    decision: CheckpointDecision,
    note: string,
    selected: string[],
    amendments?: TeamPreviewAmendments,
  ) => void;
  onOpenLive?: () => void;
}) {
  const [submitting, setSubmitting] = useState<BrowserLoginSubmitKind | null>(
    null,
  );
  const busy = submitting !== null;
  const assumption = formatBrowserLoginAssumption(paused.assumptions);

  const send = (
    decision: "continue" | "stop",
    opts?: { useAssumption?: boolean },
  ) => {
    if (busy) return;
    const useAssumption = opts?.useAssumption === true && !!assumption;
    setSubmitting(
      useAssumption
        ? "use_assumption"
        : decision === "continue"
          ? "logged_in"
          : "stop",
    );
    onResume(
      decision,
      useAssumption
        ? assumption
        : decision === "continue"
          ? "已登录，继续"
          : "",
      [],
    );
  };

  return (
    <div className="pause">
      <BrowserLoginDecisionCard
        roleLabel="主 Agent"
        question={paused.question || "请完成登录后继续"}
        assumption={assumption}
        busy={busy}
        submitting={submitting}
        onLoggedIn={() => send("continue")}
        onUseAssumption={
          assumption
            ? () => send("continue", { useAssumption: true })
            : undefined
        }
        onStop={() => send("stop")}
        onOpenLive={onOpenLive}
      />
    </div>
  );
}

function formatBrowserLoginAssumption(
  assumptions: PausedTurnSummary["assumptions"] | undefined,
): string | undefined {
  const list = Array.isArray(assumptions) ? assumptions : [];
  if (list.length === 0) return undefined;
  const text = list
    .map((raw) => {
      const a = (raw ?? {}) as { label?: unknown; value?: unknown };
      const label = typeof a.label === "string" ? a.label.trim() : "";
      const value = typeof a.value === "string" ? a.value.trim() : "";
      if (label && value) return `${label}：${value}`;
      return value || label;
    })
    .filter(Boolean)
    .join("；");
  return text || undefined;
}

function ResumeCardBody({
  paused,
  onResume,
  isPlanReview,
  isTeamPreview,
  isAskUser,
}: {
  paused: PausedTurnSummary;
  onResume: (
    decision: CheckpointDecision,
    note: string,
    selected: string[],
    amendments?: TeamPreviewAmendments,
  ) => void;
  isPlanReview: boolean;
  isTeamPreview: boolean;
  isAskUser: boolean;
}) {
  const [note, setNote] = useState("");
  const showWorkers = isPlanReview || isTeamPreview;
  const questions = asRecords(paused.questions);
  const assumptions = asRecords(paused.assumptions);
  const intent = paused.intent ?? null;
  const isDailyReview = intent === "daily_review";
  const isOrganizePlan = intent === "organize_plan";
  const isProposalPick = intent === "proposal_pick";
  const isRiskAck = intent === "risk_ack";
  const isCheckboxWall = CHECKBOX_WALL.has(intent ?? "");
  // decision / kickoff / bare ask_user — compose 答复模型 +「其他」逃逸
  const isDecisionAsk =
    isAskUser && !isCheckboxWall && !isProposalPick && !isRiskAck;
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => {
    const qs = asRecords(paused.questions);
    if (CHECKBOX_WALL.has(paused.intent ?? "")) {
      return seedAllMultipleAnswers(qs);
    }
    return seedDefaultAnswers(qs);
  });
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const isDebateKickoff =
    isTeamPreview && (paused as { primitive?: string }).primitive === "debate";
  const isDelegateKickoff = isTeamPreview && !isDebateKickoff;
  const wallPicked = isDailyReview || isOrganizePlan ? pickedCount(answers) : 0;
  const proposalPicked = isProposalPick ? pickedCount(answers) : 0;

  const workers = isDelegateKickoff
    ? parseTeamPreviewWorkers(
        paused.workers as Array<Record<string, unknown>> | undefined,
      )
    : [];

  const [included, setIncluded] = useState<Set<string>>(
    () => new Set(workers.map((w) => w.run_id)),
  );
  const [tightened, setTightened] = useState<Set<string>>(() => new Set());
  const [includeHint, setIncludeHint] = useState<string | null>(null);

  const batchTools = Array.isArray(paused.tools)
    ? paused.tools.filter((t): t is string => typeof t === "string" && !!t)
    : [];

  const toggleChoice = (
    questionId: string,
    value: string,
    multiple: boolean,
  ) => {
    setAnswers((cur) => {
      const picked = cur[questionId] ?? [];
      if (multiple) {
        return {
          ...cur,
          [questionId]: picked.includes(value)
            ? picked.filter((o) => o !== value)
            : [...picked, value],
        };
      }
      return {
        ...cur,
        [questionId]: picked.includes(value) ? [] : [value],
      };
    });
    if (!multiple) {
      setOtherOn((cur) =>
        cur[questionId] ? { ...cur, [questionId]: false } : cur,
      );
    }
  };

  const toggleOther = (questionId: string, multiple: boolean) => {
    setOtherOn((cur) => {
      const turningOn = !cur[questionId];
      if (turningOn && !multiple) {
        setAnswers((a) => ({ ...a, [questionId]: [] }));
      }
      return { ...cur, [questionId]: turningOn };
    });
  };

  const collectSelected = (decision: CheckpointDecision): string[] => {
    if (decision !== "continue" || !isAskUser) return [];
    if (!CARRIES_SELECTED.has(intent ?? "")) return [];
    const out: string[] = [];
    for (const labels of Object.values(answers)) {
      for (const v of labels) {
        const t = v.trim();
        if (t) out.push(t);
      }
    }
    return out;
  };

  const collectAmendments = (
    decision: CheckpointDecision,
  ): TeamPreviewAmendments | undefined => {
    if (decision !== "continue" || !isDelegateKickoff || workers.length === 0) {
      return undefined;
    }
    const excluded_run_ids = workers
      .map((w) => w.run_id)
      .filter((id) => !included.has(id));
    const write_capability_overrides = workers
      .filter((w) => included.has(w.run_id) && tightened.has(w.run_id))
      .map((w) => ({
        run_id: w.run_id,
        capability: "text_only" as const,
      }));
    return { excluded_run_ids, write_capability_overrides };
  };

  const tryExclude = (runId: string) => {
    if (!included.has(runId)) {
      setIncluded((prev) => new Set([...prev, runId]));
      setIncludeHint(null);
      return;
    }
    const stillIncluded = [...included].filter((id) => id !== runId);
    if (stillIncluded.length === 0) {
      setIncludeHint("至少保留 1 名队员");
      return;
    }
    const blocked = workers.some(
      (w) => stillIncluded.includes(w.run_id) && w.depends_on.includes(runId),
    );
    if (blocked) {
      setIncludeHint("仍有队员依赖此岗");
      return;
    }
    setIncluded(new Set(stillIncluded));
    setTightened((prev) => {
      if (!prev.has(runId)) return prev;
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
    setIncludeHint(null);
  };

  const toggleTighten = (runId: string) => {
    setTightened((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const submit = (decision: CheckpointDecision) => {
    const selected = collectSelected(decision);
    const amendments = collectAmendments(decision);
    let n = note.trim();
    if (decision === "continue" && isDecisionAsk) {
      n = composeAnswer(
        questions.map((q) => ({
          id: str(q, "id") ?? str(q, "prompt") ?? "",
          prompt: str(q, "prompt") ?? "",
          default: str(q, "default"),
        })),
        answers,
        otherOn,
        otherText,
        note,
      );
    } else if (decision === "stop") {
      n = note.trim();
    } else if (CARRIES_SELECTED.has(intent ?? "")) {
      n = note.trim();
    }
    if (amendments) {
      onResume(decision, n, selected, amendments);
    } else {
      onResume(decision, n, selected);
    }
  };

  const effectiveWriteLabel = (w: PreviewWorker): string | null => {
    if (tightened.has(w.run_id)) return "仅文字报告";
    return w.write_capability_label;
  };

  const effectiveWriteCap = (
    w: PreviewWorker,
  ): "text_only" | "can_write_files" | null => {
    if (tightened.has(w.run_id)) return "text_only";
    return w.write_capability;
  };

  const ctaDisabled =
    (isDailyReview || isOrganizePlan) && wallPicked === 0
      ? true
      : isProposalPick && proposalPicked === 0;

  const askIntentAttr =
    intent === "daily_review" ||
    intent === "organize_plan" ||
    intent === "proposal_pick" ||
    intent === "risk_ack" ||
    intent === "decision" ||
    intent === "kickoff"
      ? intent
      : isDecisionAsk
        ? "decision"
        : undefined;

  const title = isDebateKickoff
    ? "辩论开工 · 开赛前确认"
    : isTeamPreview
      ? "团队预审 · 开干前确认"
      : isPlanReview
        ? "执行已暂停 · 待你决定是否继续"
        : isDailyReview
          ? "复盘提案 · 确认要落盘的项"
          : isOrganizePlan
            ? "整理方案 · 确认要执行的项"
            : isProposalPick
              ? "方案挑选 · 选一条推进"
              : isRiskAck
                ? "风险确认 · 勾选本轮处理项"
                : "需要你拍板（已离线保留）";

  const primaryCta = isDebateKickoff
    ? "开赛"
    : isTeamPreview
      ? "授权并开工"
      : isDailyReview
        ? wallPicked > 0
          ? `确认落盘（${wallPicked}）`
          : "确认落盘"
        : isOrganizePlan
          ? wallPicked > 0
            ? `确认并整理（${wallPicked}）`
            : "确认并整理"
          : isProposalPick
            ? "采用此方案"
            : isRiskAck
              ? "确认并继续"
              : isDecisionAsk
                ? "提交"
                : "继续";

  return (
    <div className="pause" data-ask-intent={askIntentAttr}>
      <div className="pause-title">{title}</div>
      {paused.user_message && (
        <div className="pause-context">{paused.user_message}</div>
      )}
      {!showWorkers && paused.question && (
        <div className="pause-question">{paused.question}</div>
      )}
      {!showWorkers && paused.context && (
        <div className="pause-context">{paused.context}</div>
      )}
      {isAskUser && assumptions.length > 0 && (
        <div className="ask-assume">
          <div className="ask-assume-label">我先按这些默认推进</div>
          {assumptions.map((a) => (
            <div
              key={str(a, "id") ?? str(a, "label") ?? ""}
              className="ask-assume-row"
            >
              <span className="ask-assume-k">{str(a, "label")}</span>
              <span className="ask-assume-v">{str(a, "value")}</span>
            </div>
          ))}
        </div>
      )}
      {isAskUser &&
        questions.map((q) => {
          const id = str(q, "id") ?? str(q, "prompt") ?? "";
          const prompt = str(q, "prompt") ?? "";
          const kind = str(q, "kind");
          const def = str(q, "default");
          const multiple = Boolean(q.multiple);
          const options = asRecords(q.options);
          const picked = answers[id] ?? [];

          if (isCheckboxWall) {
            return (
              <div key={id} className="ask-question">
                {prompt && (
                  <div className="ask-prompt">
                    {prompt}
                    <span className="ask-prompt-hint">
                      {isOrganizePlan ? "取消勾选即剔除" : "取消勾选即跳过"}
                    </span>
                  </div>
                )}
                <fieldset className="ask-check-list">
                  {prompt ? (
                    <legend className="sr-only">{prompt}</legend>
                  ) : null}
                  {options.map((o) => {
                    const label = str(o, "label") ?? "";
                    if (!label) return null;
                    const detailRaw = isDailyReview
                      ? reviewOptionDetail(o)
                      : organizeOptionDetail(o);
                    const detail =
                      detailRaw && detailRaw !== label ? detailRaw : undefined;
                    const selected = picked.includes(label);
                    const inputId = `${intent ?? "wall"}-${id}-${label}`;
                    return (
                      <label
                        key={label}
                        htmlFor={inputId}
                        className={
                          selected
                            ? "ask-check-row ask-check-row-active"
                            : "ask-check-row"
                        }
                      >
                        <input
                          id={inputId}
                          type="checkbox"
                          className="ask-check-input"
                          checked={selected}
                          onChange={() => toggleChoice(id, label, true)}
                        />
                        <span
                          className={
                            selected
                              ? "ask-check-box ask-check-box-on"
                              : "ask-check-box"
                          }
                          aria-hidden
                        />
                        <span className="ask-check-text">
                          <span className="ask-check-label">{label}</span>
                          {detail && (
                            <span className="ask-check-detail">{detail}</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              </div>
            );
          }

          if (isProposalPick || isRiskAck) {
            return (
              <div key={id} className="ask-question">
                {prompt && (
                  <div className="ask-prompt">
                    {prompt}
                    {isRiskAck && (
                      <span className="ask-prompt-hint">可多选</span>
                    )}
                  </div>
                )}
                <fieldset className="ask-check-list">
                  {options.map((o) => {
                    const label = str(o, "label") ?? "";
                    if (!label) return null;
                    const detail = str(o, "detail") ?? undefined;
                    const recommended = Boolean(o.recommended);
                    const selected = picked.includes(label);
                    let displayLabel = label;
                    const hints: string[] = [];
                    if (isRiskAck) {
                      const parsed = parseRiskLabel(label);
                      displayLabel = parsed.text;
                      if (parsed.severity) {
                        hints.push(RISK_SEVERITY_TAG[parsed.severity]);
                      }
                      if (recommended && def !== label) {
                        hints.push("建议处理");
                      }
                    } else if (recommended && def !== label) {
                      hints.push("推荐");
                    }
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={selected}
                        className={
                          selected
                            ? "ask-check-row ask-check-row-active"
                            : "ask-check-row"
                        }
                        onClick={() =>
                          toggleChoice(id, label, isRiskAck || multiple)
                        }
                      >
                        <span
                          className={
                            selected
                              ? "ask-check-box ask-check-box-on"
                              : "ask-check-box"
                          }
                          aria-hidden
                        />
                        <span className="ask-check-text">
                          <span className="ask-check-label">
                            {displayLabel}
                          </span>
                          {detail && (
                            <span className="ask-check-detail">{detail}</span>
                          )}
                        </span>
                        {hints.length > 0 && (
                          <span className="ask-row-hint">
                            {hints.join(" · ")}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </fieldset>
              </div>
            );
          }

          // decision / kickoff / bare ask — rows +「其他」+ text kind
          if (kind === "text") {
            return (
              <div key={id} className="ask-question">
                {prompt && <div className="ask-prompt">{prompt}</div>}
                <input
                  type="text"
                  className="ask-other-input"
                  value={picked[0] ?? ""}
                  placeholder={def || "填写你的答案"}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAnswers((cur) => ({
                      ...cur,
                      [id]: v ? [v] : [],
                    }));
                  }}
                />
              </div>
            );
          }

          return (
            <div key={id} className="ask-question">
              {prompt && (
                <div className="ask-prompt">
                  {prompt}
                  {multiple && <span className="ask-prompt-hint">可多选</span>}
                </div>
              )}
              <fieldset className="ask-check-list">
                {options.map((o) => {
                  const label = str(o, "label") ?? "";
                  if (!label) return null;
                  const detail = str(o, "detail") ?? undefined;
                  const action = str(o, "action");
                  const folderOnly = isDesktopFolderAction(action);
                  const recommended = Boolean(o.recommended);
                  const selected = !folderOnly && picked.includes(label);
                  const hint = folderOnly
                    ? "仅桌面端可用"
                    : recommended && def !== label
                      ? "推荐"
                      : undefined;
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={selected}
                      disabled={folderOnly}
                      className={
                        selected
                          ? "ask-check-row ask-check-row-active"
                          : folderOnly
                            ? "ask-check-row ask-check-row-muted"
                            : "ask-check-row"
                      }
                      onClick={() => {
                        if (folderOnly) return;
                        toggleChoice(id, label, multiple);
                      }}
                    >
                      <span
                        className={
                          selected
                            ? "ask-check-box ask-check-box-on"
                            : "ask-check-box"
                        }
                        aria-hidden
                      />
                      <span className="ask-check-text">
                        <span className="ask-check-label">{label}</span>
                        {detail && (
                          <span className="ask-check-detail">{detail}</span>
                        )}
                      </span>
                      {hint && <span className="ask-row-hint">{hint}</span>}
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={!!otherOn[id]}
                  className={
                    otherOn[id]
                      ? "ask-check-row ask-check-row-active"
                      : "ask-check-row ask-check-row-muted"
                  }
                  onClick={() => toggleOther(id, multiple)}
                >
                  <span
                    className={
                      otherOn[id]
                        ? "ask-check-box ask-check-box-on"
                        : "ask-check-box"
                    }
                    aria-hidden
                  />
                  <span className="ask-check-text">
                    <span className="ask-check-label">其他…</span>
                  </span>
                </button>
              </fieldset>
              {otherOn[id] && (
                <input
                  type="text"
                  className="ask-other-input"
                  value={otherText[id] ?? ""}
                  placeholder="填写你的答案"
                  // biome-ignore lint/a11y/noAutofocus: 用户点开「其他」才渲染，聚焦刚展开字段是预期 UX。
                  autoFocus
                  onChange={(e) =>
                    setOtherText((cur) => ({
                      ...cur,
                      [id]: e.target.value,
                    }))
                  }
                />
              )}
            </div>
          );
        })}
      {isPlanReview && (paused.steps?.length ?? 0) > 0 && (
        <div className="pause-steps">
          {(paused.steps ?? []).map((s, i) => {
            const role = str(s, "role") ?? str(s, "task");
            const summary = str(s, "output_summary");
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: persisted, stable order
              <div key={i} className="pause-step">
                {role && <div className="pause-step-role">{role}</div>}
                {summary && <div className="pause-step-summary">{summary}</div>}
              </div>
            );
          })}
        </div>
      )}
      {isTeamPreview &&
        (paused as { primitive?: string }).primitive === "debate" && (
          <div className="pause-steps">
            {(paused as { motion?: string }).motion && (
              <div className="pause-step">
                <div className="pause-step-role">辩题</div>
                <div className="pause-step-summary">
                  {(paused as { motion: string }).motion}
                </div>
              </div>
            )}
            {(() => {
              const kick = paused as {
                sides?: Array<{
                  name?: string;
                  model?: string;
                  origin?: string;
                }>;
                moderator_model?: string;
                moderator_origin?: string;
              };
              const roster = formatDebateRosterLine(
                kick.sides ?? [],
                kick.moderator_model,
                kick.moderator_origin,
              );
              return roster ? (
                <div className="pause-step" data-testid="debate-roster-line">
                  <div className="pause-step-summary">{roster}</div>
                </div>
              ) : null;
            })()}
            {(
              (paused as { sides?: Array<Record<string, unknown>> }).sides ?? []
            ).map((s, i) => {
              const name = str(s, "name");
              const stance = str(s, "stance");
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: persisted, stable order
                <div key={i} className="pause-step">
                  {name && <div className="pause-step-role">{name}</div>}
                  {stance && <div className="pause-step-summary">{stance}</div>}
                </div>
              );
            })}
          </div>
        )}
      {isDelegateKickoff && workers.length > 0 && (
        <div className="pause-steps" data-testid="team-preview-workers">
          {workers.map((w) => {
            const on = included.has(w.run_id);
            const writeCap = effectiveWriteCap(w);
            const writeLabel = effectiveWriteLabel(w);
            const canTighten = w.write_capability === "can_write_files";
            return (
              <div
                key={w.run_id}
                className={on ? "pause-step" : "pause-step pause-step-excluded"}
                data-testid={`team-worker-${w.run_id}`}
              >
                <div className="pause-worker-head">
                  {w.role && <div className="pause-step-role">{w.role}</div>}
                  {writeLabel && (
                    <span
                      className={
                        writeCap === "text_only"
                          ? "pause-worker-cap pause-worker-cap-text"
                          : "pause-worker-cap"
                      }
                    >
                      {writeLabel}
                    </span>
                  )}
                  {w.depends_on.length > 0 && (
                    <span className="pause-worker-dep">
                      依赖 {w.depends_on.length} 步
                    </span>
                  )}
                </div>
                {w.task && <div className="pause-step-summary">{w.task}</div>}
                <div className="pause-worker-controls">
                  <label className="pause-worker-include">
                    <input
                      type="checkbox"
                      checked={on}
                      aria-label={`纳入本轮 ${w.role || w.run_id}`}
                      onChange={() => tryExclude(w.run_id)}
                    />
                    <span>纳入本轮</span>
                  </label>
                  {canTighten && on && (
                    <button
                      type="button"
                      className={
                        tightened.has(w.run_id)
                          ? "pause-worker-tighten pause-worker-tighten-on"
                          : "pause-worker-tighten"
                      }
                      aria-pressed={tightened.has(w.run_id)}
                      onClick={() => toggleTighten(w.run_id)}
                    >
                      {tightened.has(w.run_id) ? "仅文字报告" : "改为仅文字"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {includeHint && (
            <div className="pause-hint" data-testid="team-include-hint">
              {includeHint}
            </div>
          )}
          {batchTools.length > 0 && (
            <div className="pause-hint" data-testid="team-tools-summary">
              本批工具：{batchTools.join(" · ")}
            </div>
          )}
        </div>
      )}
      {isDelegateKickoff &&
        workers.length === 0 &&
        (paused.workers?.length ?? 0) > 0 && (
          <div className="pause-steps">
            {(paused.workers ?? []).map((w, i) => {
              const role = str(w, "role");
              const task = str(w, "task");
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: persisted, stable order
                <div key={i} className="pause-step">
                  {role && <div className="pause-step-role">{role}</div>}
                  {task && <div className="pause-step-summary">{task}</div>}
                </div>
              );
            })}
          </div>
        )}
      <textarea
        className="pause-note"
        rows={2}
        value={note}
        placeholder={
          isTeamPreview &&
          (paused as { primitive?: string }).primitive === "debate"
            ? "可选 · 开赛嘱咐（如你最关心的争议点），授权开赛时注入"
            : isTeamPreview
              ? "可选 · 对全体队员的嘱咐（授权开工时注入）"
              : isPlanReview
                ? "可选 · 调整时作为对下游的指示；停止时作为收尾备注"
                : isDecisionAsk
                  ? "可选 · 补充说明"
                  : "可选 · 你的答复或补充，留空则按上面继续"
        }
        onChange={(e) => setNote(e.target.value)}
      />
      {isDailyReview && (
        <div className="pause-hint">
          确认后服务端直接写入记忆/规则/文档，无需再跑工具
        </div>
      )}
      {isOrganizePlan && (
        <div className="pause-hint">
          确认后按方案批量执行，不再二次弹审批；完成后可撤销本次 move/mkdir。
        </div>
      )}
      <div className="pause-actions">
        <button
          type="button"
          className="pause-btn pause-btn-primary"
          disabled={ctaDisabled}
          onClick={() => submit("continue")}
        >
          {primaryCta}
        </button>
        {isPlanReview && (
          <button
            type="button"
            className="pause-btn pause-btn-neutral"
            disabled={!note.trim()}
            onClick={() => submit("adjust")}
          >
            调整
          </button>
        )}
        <button
          type="button"
          className="pause-btn pause-btn-danger"
          onClick={() => submit("stop")}
        >
          {isAskUser ? "跳过" : "停止"}
        </button>
      </div>
    </div>
  );
}
