/**
 * 发送前收口附件：等附加阶段就已开跑的上传落地，凑齐 `OutgoingAttachment[]`。
 *
 * 两条纪律：**并行**（多文件不再一个个 await，串行让 N 个文件慢 N 倍）、
 * **不重跑**（在途的只等，已成的直接用），发送按钮的等待因此只剩「最后一点尾巴」。
 */

import type { OutgoingAttachment } from "@/services/streamConversation";
import { awaitAttachmentUpload } from "./attachmentUploads";
import type { PendingAttachment } from "./composerAttachments";
import {
  type ResideResult,
  ensureAttachmentResident,
} from "./resideAttachment";

export type SettledAttachments =
  | { ok: true; outgoing: OutgoingAttachment[] }
  | {
      ok: false;
      reason: string;
      /** 暂存已失效、留在草稿里也没用的附件——调用方应把它们摘掉。 */
      staleIds: string[];
    };

/** 有字节要落地的附件（文件类），而非对话 / 目录这类纯文本引用。 */
function needsResidency(a: PendingAttachment): boolean {
  return (
    a.kind === "file" &&
    Boolean(a.stagingId || a.workspacePath || a.binary || a.fileBlob)
  );
}

function passthrough(a: PendingAttachment): OutgoingAttachment {
  return {
    name: a.name,
    path: a.path,
    text: a.text,
    truncated: a.truncated,
    kind: a.kind,
    conversation_id: a.conversationId,
    binary: a.binary,
    workspace_path: a.workspacePath,
  };
}

async function settleOne(
  conversationId: string,
  a: PendingAttachment,
): Promise<
  { ok: true; outgoing: OutgoingAttachment } | { ok: false; reason: string }
> {
  if (!needsResidency(a)) return { ok: true, outgoing: passthrough(a) };

  let res: ResideResult | null = await awaitAttachmentUpload(
    a.id,
    conversationId,
  );
  // 没登记（历史草稿 / 换了会话）或附加时就失败了 → 发送时再试一次。
  if (!res || !res.ok) {
    const resided = await ensureAttachmentResident(conversationId, a);
    res = resided.ok
      ? {
          ok: true,
          name: resided.name,
          path: resided.workspacePath || a.path,
          text: resided.text,
          truncated: resided.truncated,
          binary: resided.binary,
          workspacePath: resided.workspacePath || undefined,
        }
      : resided;
  }
  if (!res.ok) return res;

  return {
    ok: true,
    outgoing: {
      name: res.name,
      path: res.workspacePath || a.path,
      text: res.binary ? "" : res.text,
      truncated: res.truncated,
      kind: "file",
      binary: res.binary,
      workspace_path: res.workspacePath || undefined,
    },
  };
}

export async function settleAttachments(
  conversationId: string,
  pending: readonly PendingAttachment[],
): Promise<SettledAttachments> {
  if (pending.length === 0) return { ok: true, outgoing: [] };

  const settled = await Promise.all(
    pending.map((a) => settleOne(conversationId, a)),
  );

  const outgoing: OutgoingAttachment[] = [];
  const staleIds: string[] = [];
  let reason: string | null = null;
  for (const [i, res] of settled.entries()) {
    if (res.ok) {
      outgoing.push(res.outgoing);
      continue;
    }
    reason ??= res.reason;
    // 主进程暂存已被清掉：留在草稿里也发不出去，让调用方摘掉这条 chip。
    if (res.reason.includes("暂存已失效") && pending[i].stagingId) {
      staleIds.push(pending[i].id);
    }
  }
  if (reason !== null) return { ok: false, reason, staleIds };
  return { ok: true, outgoing };
}
