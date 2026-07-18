/**
 * Format conversation / trace / message IDs for support tickets.
 * Users paste this blob when reporting; ops grep logs with the same keys.
 */
export function formatSupportDiagnosticText(ids: {
  conversationId?: string | null;
  traceId?: string | null;
  messageId?: string | null;
}): string {
  const lines: string[] = [];
  if (ids.conversationId?.trim()) {
    lines.push(`conversation_id: ${ids.conversationId.trim()}`);
  }
  if (ids.traceId?.trim()) {
    lines.push(`trace_id: ${ids.traceId.trim()}`);
  }
  if (ids.messageId?.trim()) {
    lines.push(`message_id: ${ids.messageId.trim()}`);
  }
  return lines.join("\n");
}
