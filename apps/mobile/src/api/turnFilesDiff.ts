// A1+ 回合文件真 diff —— 手机云端 REST（前端技术与架构 §七）。
//
// 仿桌面 turnFilesDiff 语义，仅接云路径；无 sidecar / Local。
// Wire = OpenAPI TurnFilesDiffResponse（snake）；`data[]` → camel `changes`。
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];
type WireDiff = Schemas["TurnFilesDiffResponse"];
type WireChange = Schemas["TurnFileChange"];

export type TurnChangeType = WireChange["change_type"];

export interface TurnFileChange {
  path: string;
  changeType: TurnChangeType;
  baseSha: string | null;
  resultSha: string | null;
  isBinary: boolean;
  content: string | null;
  sizeBytes: number;
  baseContent: string | null;
}

export interface TurnFilesDiff {
  messageId: string;
  baselineSnapshotId: string | null;
  available: boolean;
  changes: TurnFileChange[];
  total: number;
  added: number;
  modified: number;
  deleted: number;
}

function mapChange(c: WireChange): TurnFileChange {
  return {
    path: c.path,
    changeType: c.change_type,
    baseSha: c.base_sha,
    resultSha: c.result_sha,
    isBinary: c.is_binary,
    content: c.content,
    sizeBytes: c.size_bytes,
    baseContent: c.base_content ?? null,
  };
}

function fromWire(raw: WireDiff): TurnFilesDiff {
  return {
    messageId: raw.message_id,
    baselineSnapshotId: raw.baseline_snapshot_id,
    available: raw.available,
    changes: (raw.data ?? []).map(mapChange),
    total: raw.total,
    added: raw.added,
    modified: raw.modified,
    deleted: raw.deleted,
  };
}

/** Cloud path: ``GET …/messages/{id}/files/diff``. */
export async function getTurnFilesDiff(
  conversationId: string,
  messageId: string,
): Promise<TurnFilesDiff> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/messages/${messageId}/files/diff`,
  );
  if (!res.ok) throw new Error(`加载回合文件改动失败 (${res.status})`);
  const raw = (await res.json()) as WireDiff;
  return fromWire(raw);
}
