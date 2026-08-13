import { ApiError, NetworkError } from "@/services/api";
import {
  KEY_CONFIG_ERROR_CODES,
  NON_RETRIABLE_ERROR_CODES,
} from "@agentcore/contract-types";

/**
 * One place that turns any backend / transport error into the three things the
 * UI needs: a zh message, an optional one-click remedy, and whether an immediate
 * retry is worth offering. Both the REST client ({@link ApiError}) and the SSE
 * turn ({@link StreamError}) feed through here, so a given error `code` is phrased
 * and actioned identically wherever it surfaces — the turn banner, the inline
 * mid-stream card, and the REST toast.
 *
 * The backend is the single source of the error contract: every failure is
 * `{ error: { code, message } }` plus an HTTP status (and `Retry-After` on
 * cool-downs), produced by the global handler in `apps/server` over the
 * `AgentCoreError` hierarchy (`core/errors.py`). That `message` is already a
 * user-facing zh string for most coded errors, so we prefer it verbatim and only
 * fall back to generic phrasing when it is absent.
 */

// "sidecar" = a local-engine turn failure (spawn/init/engine/exit) whose precise
// reason rides on `serverMessage` — it is neither a real network outage nor an
// auth issue, so it falls through to the serverMessage branch in resolveMessage
// (a generic "network" banner would mask why the local engine couldn't run).
export type StreamErrorKind = "network" | "http" | "auth" | "sidecar";

/**
 * A transport-level failure of an SSE turn (distinct from a backend `error`
 * event, which is delivered inline). Carries a kind so the UI can phrase it, plus
 * the backend's `code` / `message` / `Retry-After` when the turn was refused with
 * a plain JSON 4xx (quota / rate limit / missing key) rather than an event stream.
 */
export class StreamError extends Error {
  code?: string;
  serverMessage?: string;
  retryAfter?: number;
  /** 本回合在产生任何可见输出 / 副作用之前就失败了——调用方可安全地改走另一条链路重跑整轮
   * 而不重复输出 / 副作用。当前用途：sidecar 启动期失败（引擎没跑起来）自动降级回云端。 */
  recoverable?: boolean;

  constructor(
    public kind: StreamErrorKind,
    public status?: number,
    extra?: {
      code?: string;
      serverMessage?: string;
      retryAfter?: number;
      recoverable?: boolean;
    },
  ) {
    super(`stream ${kind}${status ? ` ${status}` : ""}`);
    this.name = "StreamError";
    this.code = extra?.code;
    this.serverMessage = extra?.serverMessage;
    this.retryAfter = extra?.retryAfter;
    this.recoverable = extra?.recoverable;
  }
}

/** Short diagnosis labels for degraded empty-response finishes (mirrors backend). */
export const EMPTY_RESPONSE_CHIP_LABELS: Record<string, string> = {
  upstream_non_api: "上游返回了网页或登录页，请检查服务商地址与鉴权",
  // Old journals may still stamp oauth_expired — same surface as upstream_non_api.
  oauth_expired: "上游返回了网页或登录页，请检查服务商地址与鉴权",
  content_filtered: "内容被过滤",
  model_unknown: "模型名未被上游识别",
  silent_empty: "模型返回空内容",
  format_mismatch: "上游响应格式异常",
  length_empty: "输出长度截断 · 返回空内容",
};

/** Chip suffix for degraded finish when an empty-response diagnosis is available. */
export function degradedFinishChipLabel(
  diagnosis: string | undefined,
  errorMessage: string | undefined,
): string | undefined {
  if (diagnosis && EMPTY_RESPONSE_CHIP_LABELS[diagnosis]) {
    return EMPTY_RESPONSE_CHIP_LABELS[diagnosis];
  }
  if (errorMessage?.includes(" · ")) {
    return errorMessage.split(" · ", 2)[1];
  }
  return undefined;
}

/**
 * True when the assistant bubble already owns the empty-response red card —
 * FinishReasonChip must not stack on top (单一用户面).
 */
export function isEmptyResponseUserSurface(opts: {
  code?: string | null;
  emptyDiagnosis?: string | null;
  message?: string | null;
}): boolean {
  if (opts.code === "LLM_EMPTY_RESPONSE") return true;
  if (opts.emptyDiagnosis) return true;
  const msg = opts.message ?? "";
  return msg.includes("模型多次空响应") || msg.includes("模型空响应");
}

/** Product copy for upstream 429 (mirrors backend LLMRateLimitError / history 注记). */
export const LLM_RATE_LIMIT_MESSAGE =
  "上游限流，暂时无法继续本回合。请稍后再试。";

/** Product copy when the desktop client is below the server force-update floor. */
export const CLIENT_TOO_OLD_MESSAGE = "桌面端版本过旧，请更新后再试";

/** Assistant bubble error text; in dev, append upstream body preview when present. */
export function formatAssistantErrorMessage(error: {
  message: string;
  code?: string;
  context?: DescribedError["context"];
}): string {
  const { message, context, code } = error;
  // Old journals may still carry English "Rate limited…" — normalize to product copy.
  let text =
    code === "LLM_RATE_LIMIT" &&
    (!message || /rate limited/i.test(message) || !message.includes("上游限流"))
      ? LLM_RATE_LIMIT_MESSAGE
      : message;
  if (import.meta.env.DEV && context?.upstream_body_preview) {
    text = `${text} — ${context.upstream_body_preview}`;
  }
  return text;
}

/**
 * Codes whose primary remedy is opening 设置·服务商 (auth / balance / key missing).
 * Extends {@link KEY_CONFIG_ERROR_CODES} with balance so the bubble offers「去设置」.
 */
const SETTINGS_ERROR_CODES: readonly string[] = [
  ...(KEY_CONFIG_ERROR_CODES as readonly string[]),
  "LLM_INSUFFICIENT_BALANCE",
];

/** Connectivity / transport-ish codes — bubble offers「重试」, not settings. */
const CONNECTIVITY_ERROR_CODES: readonly string[] = [
  "LLM_TIMEOUT",
  "LLM_ERROR",
  "LLM_UPSTREAM_ERROR",
  "LLM_RATE_LIMIT",
];

/**
 * Our-cloud faults (pool / billing / key storage / internal) — never treat as
 * vendor Base URL / API Key connectivity. Codes must stay out of
 * {@link CONNECTIVITY_ERROR_CODES} so session escalation counters stay clean.
 */
const OUR_SERVICE_ERROR_CODES: readonly string[] = [
  "DATABASE_UNAVAILABLE",
  "KEY_STORAGE_UNAVAILABLE",
  "PLATFORM_BILLING_UNAVAILABLE",
  "INTERNAL_ERROR",
];

/** Product copy when our cloud (not the vendor) is busy / unavailable. */
export const OUR_SERVICE_UNAVAILABLE_MESSAGE =
  "AgentCore 服务暂时不可用，请稍后重试";

/** Session-scoped counter for connectivity failures (resets on full page reload). */
const _sessionConnectivityCounts = new Map<string, number>();
/** Message ids already counted — format/render must not double-increment. */
const _countedErrorMessageIds = new Set<string>();

export function isConnectivityErrorCode(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (CONNECTIVITY_ERROR_CODES as readonly string[]).includes(code) &&
    !(OUR_SERVICE_ERROR_CODES as readonly string[]).includes(code)
  );
}

/** True when the failure is our cloud (not vendor Base URL / API Key). */
export function isOurServiceErrorCode(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (OUR_SERVICE_ERROR_CODES as readonly string[]).includes(code)
  );
}

/** Increment once per message id; return the session count for that code. */
export function noteSessionConnectivityFailure(
  code: string,
  messageId: string,
): number {
  if (!_countedErrorMessageIds.has(messageId)) {
    _countedErrorMessageIds.add(messageId);
    _sessionConnectivityCounts.set(
      code,
      (_sessionConnectivityCounts.get(code) ?? 0) + 1,
    );
  }
  return _sessionConnectivityCounts.get(code) ?? 0;
}

/** True when the failure is a request/params rejection, not transport/connectivity. */
export function isClientSideLlmRejection(opts?: {
  message?: string | null;
  upstreamStatus?: number;
}): boolean {
  const status = opts?.upstreamStatus;
  // 4xx (except 429 rate limit) are client/request problems — do not escalate
  // them into "check Base URL / API Key / network".
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return true;
  }
  const msg = (opts?.message ?? "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("invalid_request") ||
    msg.includes("请求参数") ||
    msg.includes("不被当前模型支持") ||
    msg.includes("请求格式被拒绝") ||
    msg.includes("cc switch")
  );
}

/**
 * Escalation copy for the 2nd+ connectivity failure in this session.
 * Side-effect: counts this message id at most once.
 * Skips client-side request rejections (e.g. upstream 400 invalid_request).
 */
export function connectivityEscalationSuffix(
  code: string | undefined,
  messageId: string,
  opts?: {
    message?: string | null;
    upstreamStatus?: number;
    /** Empty-response diagnosis — never escalate into Base URL / API Key copy. */
    emptyDiagnosis?: string;
  },
): string | null {
  // LLM_EMPTY_RESPONSE is not a connectivity code; still guard explicitly so a
  // future catalog slip cannot append「检查 Base URL / API Key」onto the red card.
  if (code === "LLM_EMPTY_RESPONSE") return null;
  if (opts?.emptyDiagnosis) return null;
  // Our-cloud 5xx (pool / internal): honest retry, never「设置 · 服务商」.
  if (isOurServiceErrorCode(code)) return null;
  if (!code || !isConnectivityErrorCode(code)) return null;
  if (isClientSideLlmRejection(opts)) return null;
  const n = noteSessionConnectivityFailure(code, messageId);
  if (n < 2) return null;
  return "\n\n多次连接失败。请到「设置 · 服务商」检查 Base URL / API Key 与网络后重试。";
}

/** Test helper — clear session connectivity counters. */
export function resetSessionConnectivityFailures(): void {
  _sessionConnectivityCounts.clear();
  _countedErrorMessageIds.clear();
}

/** Product copy for empty unproductive turns (tool loop / invalid args). */
export const LLM_UNPRODUCTIVE_MESSAGE =
  "工具连续无有效进展或参数无效，请重试。";

/** Empty cancelled (user Stop) — synthetic code for fold/preview skips; chat timeline omits the face (P1). */
export const TURN_CANCELLED_EMPTY_MESSAGE = "已停止";

/**
 * Empty interrupted / preempted placeholder — layer-1 recoverability
 * (send next turn); keep in sync with composerContinueHint copy.
 */
export const TURN_INTERRUPTED_EMPTY_MESSAGE =
  "已中断。直接发送下一条即可重试。";

/**
 * Platform auth dead product sentence (align byok/platform 甲; not byok main fix).
 * Used when empty cancelled/error carries ``LLM_KEY_INVALID`` without a live message.
 */
export const PLATFORM_AUTH_UNAVAILABLE_MESSAGE =
  "平台模型暂时不可用（上游鉴权失败）。请改用自己的 API Key，或联系管理员。";

/** Generic empty-failure fallback when no code/message product sentence exists. */
export const GENERIC_EMPTY_FAILURE_MESSAGE = "本轮未能完成，请重试。";

/** Code → product sentence (tier-1 face copy). Unknown codes fall through to generic. */
const PRODUCT_COPY_BY_CODE: Record<string, string> = {
  LLM_RATE_LIMIT: LLM_RATE_LIMIT_MESSAGE,
  LLM_KEY_INVALID: PLATFORM_AUTH_UNAVAILABLE_MESSAGE,
  LLM_UNPRODUCTIVE: LLM_UNPRODUCTIVE_MESSAGE,
  LLM_INSUFFICIENT_BALANCE: "上游账户余额不足，请充值或更换 Key。",
  LLM_TIMEOUT: "连接超时，请检查网络后重试。",
  LLM_EMPTY_RESPONSE: "模型返回空内容，请重试。",
  PIPELINE_ERROR: "管线执行失败，请重试。",
  TURN_INTERRUPTED: TURN_INTERRUPTED_EMPTY_MESSAGE,
  TURN_CANCELLED: TURN_CANCELLED_EMPTY_MESSAGE,
  LLM_ERROR: "模型调用失败，请重试。",
  DATABASE_UNAVAILABLE: OUR_SERVICE_UNAVAILABLE_MESSAGE,
  KEY_STORAGE_UNAVAILABLE: OUR_SERVICE_UNAVAILABLE_MESSAGE,
  PLATFORM_BILLING_UNAVAILABLE: OUR_SERVICE_UNAVAILABLE_MESSAGE,
  INTERNAL_ERROR: OUR_SERVICE_UNAVAILABLE_MESSAGE,
};

export type AssistantFailureFace = { code: string; message: string };

type StructuredErr =
  | {
      code?: string | null;
      message?: string | null;
    }
  | null
  | undefined;

/**
 * Single authority for assistant failure face (空泡族根因重设计).
 *
 * Default ON: empty content + any structured error source, or empty + failure
 * finishReason. Short silent exemption list:
 * - user-initiated stop (cancelled / TURN_CANCELLED) — chat timeline omits face
 * - paused / ask when a dedicated interaction card already owns the UI
 *
 * Copy tiers: structured message → code product sentence → generic fallback.
 */
export function resolveAssistantFailureFace(input: {
  content?: string | null;
  isStreaming?: boolean;
  error?: StructuredErr;
  runsError?: StructuredErr;
  usageError?: StructuredErr;
  finishReason?: string | null;
  /** True when pause/ask/checkpoint/plan_review/… card already carries the turn. */
  hasDedicatedPauseOrAskUi?: boolean;
}): AssistantFailureFace | null {
  if (input.isStreaming) return null;

  const structured =
    coalesceStructured(input.error) ??
    coalesceStructured(input.runsError) ??
    coalesceStructured(input.usageError);

  const fr = input.finishReason ?? undefined;
  const empty = !(input.content ?? "").trim();

  // Auth / key codes win even when local settle stamped cancelled.
  if (structured?.code === "LLM_KEY_INVALID") {
    return faceFromStructured(structured);
  }
  if (structured?.code === "LLM_RATE_LIMIT") {
    return faceFromStructured(structured);
  }

  // User-stop exemption: still return TURN_CANCELLED so StatusStrip / preview
  // can label; chat timeline hides via isUserStopped / isEmptyCancelledAssistant.
  // Auth / rate-limit codes already returned above (win over cancelled).
  if (structured?.code === "TURN_CANCELLED" || fr === "cancelled") {
    return {
      code: "TURN_CANCELLED",
      message: TURN_CANCELLED_EMPTY_MESSAGE,
    };
  }

  if (structured) {
    return faceFromStructured(structured);
  }

  // No structured payload — synthesize from finishReason.
  if (!empty && fr === "error") {
    return { code: "LLM_ERROR", message: PRODUCT_COPY_BY_CODE.LLM_ERROR };
  }
  if (!empty) return null;

  if (fr === "unproductive") {
    return {
      code: "LLM_UNPRODUCTIVE",
      message: LLM_UNPRODUCTIVE_MESSAGE,
    };
  }
  if (fr === "interrupted") {
    return {
      code: "TURN_INTERRUPTED",
      message: TURN_INTERRUPTED_EMPTY_MESSAGE,
    };
  }
  if (fr === "error") {
    return { code: "LLM_ERROR", message: PRODUCT_COPY_BY_CODE.LLM_ERROR };
  }
  if (fr === "degraded") {
    return {
      code: "LLM_EMPTY_RESPONSE",
      message: PRODUCT_COPY_BY_CODE.LLM_EMPTY_RESPONSE,
    };
  }
  if (fr === "paused") {
    if (input.hasDedicatedPauseOrAskUi) return null;
    return {
      code: "TURN_INCOMPLETE",
      message: GENERIC_EMPTY_FAILURE_MESSAGE,
    };
  }
  return null;
}

function coalesceStructured(
  err: StructuredErr,
): { code: string; message: string } | null {
  if (!err) return null;
  const code = (err.code ?? "").trim();
  const message = (err.message ?? "").trim();
  if (!code && !message) return null;
  return { code: code || "LLM_ERROR", message };
}

function faceFromStructured(err: {
  code: string;
  message: string;
}): AssistantFailureFace {
  const code = err.code || "LLM_ERROR";
  if (err.message.trim()) {
    // Prefer upstream/product message; normalize known rate-limit English.
    if (
      code === "LLM_RATE_LIMIT" &&
      (/rate limited/i.test(err.message) || !err.message.includes("上游限流"))
    ) {
      return { code, message: LLM_RATE_LIMIT_MESSAGE };
    }
    return { code, message: err.message.trim() };
  }
  return {
    code,
    message: PRODUCT_COPY_BY_CODE[code] ?? GENERIC_EMPTY_FAILURE_MESSAGE,
  };
}

/**
 * When reload lost the error payload but left an empty failure-finished bubble,
 * synthesize a minimal card. Thin wrapper over {@link resolveAssistantFailureFace}
 * (finishReason + optional code only).
 */
export function syntheticErrorForEmptyFailure(
  finishReason: string | undefined,
  code?: string | null,
): {
  code: string;
  message: string;
} | null {
  return resolveAssistantFailureFace({
    content: "",
    finishReason,
    runsError: code ? { code, message: "" } : null,
  });
}

/**
 * Hard-fail red card when `finishReason=error` but `message.error` is missing.
 * Prefer `runs.error` copy when present; else the empty-failure synthetic.
 */
export function syntheticErrorForHardFailure(
  finishReason: string | undefined,
  runsError?: { code?: string | null; message?: string | null } | null,
): {
  code: string;
  message: string;
} | null {
  if (finishReason !== "error") return null;
  return resolveAssistantFailureFace({
    content: "",
    finishReason,
    runsError,
  });
}

/**
 * Visible sentence for preview / export / canvas outlets that otherwise only
 * read `content`. Non-empty trimmed content wins (partial deliverable); pure
 * failure falls back to `error.message` then `runs.error.message` then
 * `usage.error.message`.
 */
export function visibleMessageText(msg: {
  content?: string | null;
  error?: { message?: string } | null;
  runs?: { error?: { message?: string } | null } | null;
  usage?: { error?: { message?: string } | null } | null;
}): string {
  const content = (msg.content ?? "").trim();
  if (content) return content;
  const fromError = msg.error?.message?.trim();
  if (fromError) return fromError;
  const fromRuns = msg.runs?.error?.message?.trim();
  if (fromRuns) return fromRuns;
  const fromUsage = msg.usage?.error?.message?.trim();
  if (fromUsage) return fromUsage;
  return "";
}

/**
 * A one-click remedy that fixes the *cause* of an error by routing the user
 * somewhere (e.g. the model-config page to add a BYOK key), rather than retrying
 * the same operation. `href` is a hash-router path.
 */
export interface ErrorAction {
  label: string;
  href: string;
}

/**
 * Normalized, user-facing view of an error. A `null` return from
 * {@link describeError} means the UI should stay silent — auth failures already
 * redirect to the login screen, so a banner/toast on top would be noise.
 */
export interface DescribedError {
  message: string;
  action: ErrorAction | null;
  retriable: boolean;
  code?: string;
  /** 只放用户自己能行动的事实。运营方中转账号的诊断（Sub2API）不进这里，也不进气泡
   * ——平台模式下用户没有自己的 key，那说的是别人的账号。后端只写日志。 */
  context?: {
    upstream_status?: number;
    upstream_body_preview?: string | null;
    retry_attempts?: number;
    empty_diagnosis?: string;
    body_kind?: string;
    base_url?: string;
    retry_after?: number;
    credential_source?: "user" | "platform" | string | null;
  };
}

/**
 * Map a backend error `code` to a config remedy. Auth / key / balance → settings;
 * connectivity codes return null (the bubble shows「重试」instead).
 *
 * ``LLM_KEY_INVALID`` CTA 按凭据来源分流（甲）：
 * - user BYOK →「去设置」换 Key
 * - platform →「接入自己的 Key」（与 QUOTA_EXCEEDED 同出口；主文案已引导联系管理员）
 * ``INFERENCE_TOKEN_EXPIRED`` 永不进 settings。
 */
export function errorActionForCode(
  code: string | undefined,
  opts?: {
    credentialSource?: string | null;
    message?: string | null;
  },
): ErrorAction | null {
  // Inference JWT ≠ BYOK key — never push「去设置 · 服务商」.
  if (code === "INFERENCE_TOKEN_EXPIRED") {
    return null;
  }
  // Our cloud busy / misconfigured — retry (or wait), not vendor settings.
  if (isOurServiceErrorCode(code)) {
    return null;
  }
  if (code === "LLM_KEY_INVALID") {
    const src =
      opts?.credentialSource === "platform" || opts?.credentialSource === "user"
        ? opts.credentialSource
        : opts?.message?.includes("平台模型暂时不可用")
          ? "platform"
          : "user";
    if (src === "platform") {
      return { label: "接入自己的 Key", href: "/more/providers" };
    }
    return { label: "去设置", href: "/more/providers" };
  }
  if (code !== undefined && SETTINGS_ERROR_CODES.includes(code)) {
    return { label: "去设置", href: "/more/providers" };
  }
  // 平台额度耗尽 (QUOTA_EXCEEDED, 成本配额与计费 §〇·六 F6): 主文案是等重置 / 联系管理员，
  // 这里补一个「接入自己的 Key」次级出口 —— byok 回合不查配额, 是真正的绕过路径。
  if (code === "QUOTA_EXCEEDED") {
    return { label: "接入自己的 Key", href: "/more/providers" };
  }
  // Always-entry write gate (记忆 · 配额闸在写侧): create / promote past the cap —
  // send the user to the file rail to shrink or demote always entries.
  if (code === "ALWAYS_QUOTA_EXCEEDED") {
    return { label: "去整理", href: "/files" };
  }
  return null;
}

/** The facts the message/action/retry rules read, extracted once from any error
 * shape so the rules below never branch on the concrete class. */
interface ErrorFacts {
  status?: number;
  code?: string;
  serverMessage?: string;
  retryAfter?: number;
  context?: DescribedError["context"];
  transport: boolean;
  auth: boolean;
}

function factsOf(err: unknown): ErrorFacts {
  if (err instanceof StreamError) {
    return {
      status: err.status,
      code: err.code,
      serverMessage: err.serverMessage,
      retryAfter: err.retryAfter,
      transport: err.kind === "network",
      auth: err.kind === "auth",
    };
  }
  if (err instanceof ApiError) {
    return {
      status: err.status,
      code: err.code,
      serverMessage: err.serverMessage,
      retryAfter: err.retryAfter,
      transport: false,
      auth: err.status === 401,
    };
  }
  if (err instanceof NetworkError) {
    return { transport: true, auth: false };
  }
  return { transport: false, auth: false };
}

function resolveMessage(f: ErrorFacts): string {
  if (f.transport) return "网络连接中断，请检查网络后重试";
  // Force-update floor: CLIENT_TOO_OLD or HTTP 426 Upgrade Required.
  if (f.code === "CLIENT_TOO_OLD" || f.status === 426) {
    return CLIENT_TOO_OLD_MESSAGE;
  }
  // A 429 is a deliberate refusal (quota used up, or sending too fast), not an
  // outage. The backend ships a precise zh message (quota reset time, or a
  // cool-down), so prefer it; otherwise phrase the wait from Retry-After.
  if (f.status === 429) {
    if (f.serverMessage) return f.serverMessage;
    if (f.retryAfter) return `操作过于频繁，请约 ${f.retryAfter} 秒后再试`;
    return "操作过于频繁或额度已用尽，请稍后再试";
  }
  if (f.code === "pending_interactions_awaiting") {
    return f.serverMessage ?? "有待拍板的确认卡，先处理或停止当前任务";
  }
  if (f.code === "turn_in_progress") {
    // Residual 409 only (non-cold-resume / older server). Cold resume busy is
    // EPHEMERAL `resume_deferred` on the same SSE — not this error path; do not
    // toast this line as a deferred-success state.
    return "回合收尾尚未完成，请稍候或先显式停止后再试";
  }
  // A 402 LLM_KEY_REQUIRED is a deliberate BYOK refusal (no DeepSeek key yet);
  // surface the backend's actionable message (or a config hint), never a
  // misleading "service unavailable".
  if (f.code === "LLM_RATE_LIMIT") {
    if (f.serverMessage?.includes("上游限流")) {
      return f.serverMessage;
    }
    return LLM_RATE_LIMIT_MESSAGE;
  }
  if (f.code === "LLM_KEY_REQUIRED") {
    return (
      f.serverMessage ??
      "请先在「设置 · 服务商」中填入你的 API Key，再发起对话。"
    );
  }
  if (f.code === "INFERENCE_TOKEN_EXPIRED") {
    return (
      f.serverMessage ??
      "本地与云端的推理凭证已失效或过期。请稍后再试（将自动换新凭证）；仍失败请重新登录后再试。"
    );
  }
  if (isOurServiceErrorCode(f.code)) {
    return f.serverMessage ?? OUR_SERVICE_UNAVAILABLE_MESSAGE;
  }
  // Legacy engine builds still surface the English JWT rejection under LLM_KEY_INVALID.
  if (
    f.serverMessage &&
    /invalid or expired inference token/i.test(f.serverMessage)
  ) {
    return "本地与云端的推理凭证已失效或过期。请稍后再试（将自动换新凭证）；仍失败请重新登录后再试。";
  }
  if (f.code === "ADMIN_PRODUCT_FORBIDDEN") {
    return "此账号为管理员账号，请使用管理后台登录";
  }
  // Most coded errors carry a user-facing zh message (validation / conflict /
  // invalid key / insufficient balance …) — prefer it verbatim (single-sourced).
  if (f.serverMessage) {
    if (import.meta.env.DEV && f.context?.upstream_body_preview) {
      return `${f.serverMessage} — ${f.context.upstream_body_preview}`;
    }
    return f.serverMessage;
  }
  if (import.meta.env.DEV && f.context?.upstream_status) {
    const preview = f.context.upstream_body_preview
      ? ` — ${f.context.upstream_body_preview}`
      : "";
    return `上游推理错误（HTTP ${f.context.upstream_status}${preview}）`;
  }
  if (f.status && f.status >= 500)
    return `服务暂时不可用（${f.status}），请重试`;
  if (f.status) return `操作失败（${f.status}），请重试`;
  return "操作失败，请重试";
}

/**
 * Whether an error means "this backend build doesn't offer this endpoint" — a 404
 * (route not registered) or 501 (declared but not implemented). Distinct from a
 * transient failure: retrying won't help until the server is upgraded, so a caller
 * degrades to a calm "feature unavailable" state (no red 加载失败, no retry) instead
 * of an alarming error. Guards the 前后端版本漂移 window — a newer client calling an
 * endpoint the older *deployed* backend lacks (e.g. 记忆·主题 shipped in the client
 * before the backend redeploy). NOT for 401 (auth, handled by redirect) or 5xx
 * outages (transient, worth a retry).
 */
export function isFeatureUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

/**
 * Normalize any error into the {@link DescribedError} the UI shows, or `null`
 * when the UI should stay silent (auth → the login redirect handles it).
 */
export function describeError(err: unknown): DescribedError | null {
  const f = factsOf(err);
  if (f.auth) return null;
  const inferenceTokenFailure =
    f.code === "INFERENCE_TOKEN_EXPIRED" ||
    (f.serverMessage != null &&
      /invalid or expired inference token/i.test(f.serverMessage));
  return {
    message: resolveMessage(f),
    action: inferenceTokenFailure
      ? null
      : errorActionForCode(f.code, {
          credentialSource: f.context?.credential_source,
          message: f.serverMessage,
        }),
    // Suppress retry on refusals that an immediate re-send can't fix (quota used /
    // key missing-or-invalid / wallet empty / server key-storage down / free tier
    // exhausted). Inference JWT expiry is remintable — keep retry. The shared
    // contract-types catalog is the single source for the rest.
    retriable: inferenceTokenFailure
      ? true
      : f.code === "CLIENT_TOO_OLD" || f.status === 426
        ? false
        : !(
            f.code !== undefined &&
            (NON_RETRIABLE_ERROR_CODES as readonly string[]).includes(f.code)
          ),
    code: f.code,
    context: f.context,
  };
}

// ---- Streaming-turn helpers (thin wrappers over describeError) --------------
// Named for the SSE turn flow (banner + retry) and consumed by the turn resolver
// in services/turns.ts. They share describeError's code map so a turn banner and
// a REST toast phrase the same backend code identically.

/** zh message for a failed turn, or null when no banner should show. */
export function describeStreamError(err: unknown): string | null {
  return describeError(err)?.message ?? null;
}

/** Whether a failed turn should offer a retry. */
export function isRetriableStreamError(err: unknown): boolean {
  return describeError(err)?.retriable ?? true;
}

/** The config remedy for a failed turn, if any. */
export function streamErrorAction(err: unknown): ErrorAction | null {
  return describeError(err)?.action ?? null;
}
