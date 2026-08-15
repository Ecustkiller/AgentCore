/**
 * 异步团队收口：系统合成的「用户」消息（metadata.origin=execution_harvest）。
 * REST MessageDetail 暴露 ``origin``；正文前缀保留为旧数据兜底。
 * 前端识别后隐藏（不渲染用户气泡 / 系统芯片），避免露出模型提示词。
 */

export const EXECUTION_HARVEST_ORIGIN = "execution_harvest";

/** 通道死 / 无 LLM 时的收口回退（execution_harvest.py fallback）。 */
export const EXECUTION_HARVEST_FALLBACK_ORIGIN = "execution_harvest_fallback";

/** 后端落库的合成用户消息正文前缀（execution_harvest.py `_HARVEST_USER_TEXT`）。 */
export const HARVEST_USER_CONTENT_PREFIX = "【系统收口】";

export function isExecutionHarvestMessage(msg: {
  role: string;
  content: string;
  origin?: string | null;
}): boolean {
  if (msg.role !== "user") return false;
  if (msg.origin === EXECUTION_HARVEST_ORIGIN) return true;
  return msg.content.startsWith(HARVEST_USER_CONTENT_PREFIX);
}

/** Structured harvest provenance on outbox / RecordTurnRequest — not free-text. */
export function isHarvestWritebackOrigin(origin?: string | null): boolean {
  return (
    origin === EXECUTION_HARVEST_ORIGIN ||
    origin === EXECUTION_HARVEST_FALLBACK_ORIGIN
  );
}

/** Drain ack is a harvest write-back (origin or harvest_kind). */
export function isHarvestWritebackAck(payload: {
  origin?: string | null;
  harvestKind?: string | null;
}): boolean {
  if (isHarvestWritebackOrigin(payload.origin)) return true;
  return Boolean(payload.harvestKind);
}
