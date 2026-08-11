import type { MessageStartPayload, SSEEvent } from "@agentcore/contract-types";

export type SupportDiagnosticIds = {
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  executionId?: string | null;
  /** Optional error extras (SSE ErrorContext / empty-response); only appended when ≥1 id present. */
  errorCode?: string | null;
  emptyDiagnosis?: string | null;
  bodyKind?: string | null;
  baseUrl?: string | null;
  /** Product chat is stream=true; set for empty-response packs. */
  stream?: boolean | null;
};

/**
 * Format a paste-ready「排查包」for support / Cursor AI log lookup.
 * Lead line triggers conversation-logs workflow; trailing line is log_timeline.py.
 * Always available (no 诊断模式 on mobile) — parity with desktop error card / bubble「更多」.
 * Extras (`error_code` / `empty_diagnosis` / …) append only when at least one id line exists.
 */
export function formatSupportDiagnosticText(ids: SupportDiagnosticIds): string {
  const conversationId = ids.conversationId?.trim() || "";
  const messageId = ids.messageId?.trim() || "";
  const traceId = ids.traceId?.trim() || "";
  const executionId = ids.executionId?.trim() || "";

  const idLines: string[] = [];
  if (conversationId) idLines.push(`conversation_id: ${conversationId}`);
  if (messageId) idLines.push(`message_id: ${messageId}`);
  if (traceId) idLines.push(`trace_id: ${traceId}`);
  if (executionId) idLines.push(`execution_id: ${executionId}`);
  if (idLines.length === 0) return "";

  const errorCode = ids.errorCode?.trim() || "";
  const emptyDiagnosis = ids.emptyDiagnosis?.trim() || "";
  const bodyKind = ids.bodyKind?.trim() || "";
  const baseUrl = ids.baseUrl?.trim() || "";
  if (errorCode) idLines.push(`error_code: ${errorCode}`);
  if (emptyDiagnosis) idLines.push(`empty_diagnosis: ${emptyDiagnosis}`);
  if (bodyKind) idLines.push(`body_kind: ${bodyKind}`);
  if (baseUrl) idLines.push(`base_url: ${baseUrl}`);
  if (ids.stream === true) idLines.push("stream: true");

  const lines = ["阅读这段产品AI日志：", ...idLines];
  if (traceId) {
    lines.push(`uv run python scripts/log_timeline.py --trace ${traceId}`);
  } else if (conversationId) {
    lines.push(`uv run python scripts/log_timeline.py ${conversationId}`);
  }

  return lines.join("\n");
}

/** Pull support ids from a live/history SSE journal (message_start + first run_plan). */
export function extractSupportIdsFromEvents(events: SSEEvent[]): {
  messageId?: string;
  traceId?: string;
  executionId?: string;
} {
  let messageId: string | undefined;
  let traceId: string | undefined;
  let executionId: string | undefined;
  for (const ev of events) {
    if (ev.type === "message_start") {
      const p = ev.payload as MessageStartPayload;
      if (p.message_id) messageId = p.message_id;
      if (p.trace_id) traceId = p.trace_id;
    } else if (!executionId && ev.type === "run_plan") {
      const id = (ev.payload as { execution_id?: string }).execution_id?.trim();
      if (id) executionId = id;
    }
  }
  return { messageId, traceId, executionId };
}
