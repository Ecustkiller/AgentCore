/** Preceding user bubble id for an assistant message (regenerate / 排查包). */
export function precedingUserMessageId(
  messages: ReadonlyArray<{ id: string; role: string }>,
  assistantMessageId: string,
): string | null {
  const idx = messages.findIndex((m) => m.id === assistantMessageId);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id;
  }
  return null;
}

/**
 * Format a paste-ready「排查包」for support / Cursor AI log lookup.
 * Lead line triggers conversation-logs workflow; trailing line is log_timeline.py.
 * Always available from error cards and bubble「更多」(not gated by 诊断模式).
 * Requires at least one id; optional extras (errorCode / emptyDiagnosis / …) append
 * after ids when present — extras alone never produce a pack.
 */
export function formatSupportDiagnosticText(ids: {
  conversationId?: string | null;
  /** Prefer preceding user bubble when copying from an assistant error/regenerate face. */
  messageId?: string | null;
  userMessageId?: string | null;
  traceId?: string | null;
  executionId?: string | null;
  /** Optional LLM / empty-response extras (written only when non-empty). */
  errorCode?: string | null;
  emptyDiagnosis?: string | null;
  bodyKind?: string | null;
  baseUrl?: string | null;
  /** Product default is streaming; pass true for empty-response 排查. */
  stream?: boolean | null;
}): string {
  const conversationId = ids.conversationId?.trim() || "";
  const userMessageId = ids.userMessageId?.trim() || "";
  const messageId = ids.messageId?.trim() || "";
  const traceId = ids.traceId?.trim() || "";
  const executionId = ids.executionId?.trim() || "";
  const errorCode = ids.errorCode?.trim() || "";
  const emptyDiagnosis = ids.emptyDiagnosis?.trim() || "";
  const bodyKind = ids.bodyKind?.trim() || "";
  const baseUrl = ids.baseUrl?.trim() || "";

  const idLines: string[] = [];
  if (conversationId) idLines.push(`conversation_id: ${conversationId}`);
  // user_message_id first: regenerate / log lookup need the persisted user row, not a
  // client-only assistant UUID created before a failed stream.
  if (userMessageId) idLines.push(`user_message_id: ${userMessageId}`);
  if (messageId && messageId !== userMessageId) {
    idLines.push(`message_id: ${messageId}`);
  } else if (messageId && !userMessageId) {
    idLines.push(`message_id: ${messageId}`);
  }
  if (traceId) idLines.push(`trace_id: ${traceId}`);
  if (executionId) idLines.push(`execution_id: ${executionId}`);
  if (idLines.length === 0) return "";

  const extraLines: string[] = [];
  if (errorCode) extraLines.push(`error_code: ${errorCode}`);
  if (emptyDiagnosis) extraLines.push(`empty_diagnosis: ${emptyDiagnosis}`);
  if (bodyKind) extraLines.push(`body_kind: ${bodyKind}`);
  if (baseUrl) extraLines.push(`base_url: ${baseUrl}`);
  if (ids.stream === true) extraLines.push("stream: true");

  const lines = ["阅读这段产品AI日志：", ...idLines, ...extraLines];
  if (traceId) {
    lines.push(`uv run python scripts/log_timeline.py --trace ${traceId}`);
  } else if (conversationId) {
    lines.push(`uv run python scripts/log_timeline.py ${conversationId}`);
  }

  return lines.join("\n");
}

/**
 * Extras for 排查包 from an assistant bubble error (SSE ErrorContext).
 * ``stream: true`` when empty_diagnosis or LLM_EMPTY_RESPONSE (product default stream).
 */
export function supportDiagnosticExtrasFromError(
  error?: {
    code?: string | null;
    context?: {
      empty_diagnosis?: string | null;
      body_kind?: string | null;
      base_url?: string | null;
    } | null;
  } | null,
): {
  errorCode?: string;
  emptyDiagnosis?: string;
  bodyKind?: string;
  baseUrl?: string;
  stream?: true;
} {
  if (!error) return {};
  const errorCode = error.code?.trim() || "";
  const emptyDiagnosis = error.context?.empty_diagnosis?.trim() || "";
  const bodyKind = error.context?.body_kind?.trim() || "";
  const baseUrl = error.context?.base_url?.trim() || "";
  const extras: {
    errorCode?: string;
    emptyDiagnosis?: string;
    bodyKind?: string;
    baseUrl?: string;
    stream?: true;
  } = {};
  if (errorCode) extras.errorCode = errorCode;
  if (emptyDiagnosis) extras.emptyDiagnosis = emptyDiagnosis;
  if (bodyKind) extras.bodyKind = bodyKind;
  if (baseUrl) extras.baseUrl = baseUrl;
  if (emptyDiagnosis || errorCode === "LLM_EMPTY_RESPONSE") {
    extras.stream = true;
  }
  return extras;
}
