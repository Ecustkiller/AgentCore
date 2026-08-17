/**
 * 开工卡 / 开赛卡「调整意见」草稿。
 * 确认态嘱咐不走这里；返回确认态会清掉本键，提交 adjust 也会清。
 * 内存 + sessionStorage：切会话不丢，同 WebView 重连可恢复。
 */
const PREFIX = "ac.kickoffAdjustDraft:";

const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function kickoffAdjustDraftKey(checkpointId: string): string {
  return `${PREFIX}${checkpointId}`;
}

export function readKickoffAdjustDraft(checkpointId: string): string {
  if (!checkpointId) return "";
  const mem = memory.get(checkpointId);
  if (mem != null) return mem;
  try {
    const raw = storage()?.getItem(kickoffAdjustDraftKey(checkpointId)) ?? "";
    if (raw) memory.set(checkpointId, raw);
    return raw;
  } catch {
    return "";
  }
}

export function writeKickoffAdjustDraft(
  checkpointId: string,
  note: string,
): void {
  if (!checkpointId) return;
  memory.set(checkpointId, note);
  try {
    const s = storage();
    if (!s) return;
    const key = kickoffAdjustDraftKey(checkpointId);
    if (!note) s.removeItem(key);
    else s.setItem(key, note);
  } catch {
    /* quota / private mode */
  }
}

export function clearKickoffAdjustDraft(checkpointId: string): void {
  if (!checkpointId) return;
  memory.delete(checkpointId);
  try {
    storage()?.removeItem(kickoffAdjustDraftKey(checkpointId));
  } catch {
    /* ignore */
  }
}

/** 测试用：清内存 + sessionStorage 前缀键。 */
export function resetKickoffAdjustDraftsForTests(): void {
  memory.clear();
  try {
    const s = storage();
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    /* ignore */
  }
}
