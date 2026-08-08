// Agent-chat attachments (composer 附件 · Agent 对话).
//
// An agent-chat attachment is NOT an IM upload reference (that's api/messaging.ts).
// Text files: the client extracts UTF-8 content and ships it inline in the send body
// (backend folds it into turn context and persists into the conversation workspace).
// Images / other binary: **resident-first** — PUT raw bytes into the conversation
// workspace ``attachments/`` and send ``workspace_path`` + ``binary=true`` with empty
// ``text`` (same MessageAttachment contract as desktop). The client does not claim
// global "no vision"; whether a model can read the image is a model-combo concern.
//
// Text truncation aligns with desktop / server ``readFile`` at 256KB.

import { uploadWorkspaceFile } from "@/api/workspace";

/** Cap a single attachment's shipped text at 256KB — the same threshold the desktop and the
 *  server's `readFile` use, so「拖入 / @ 引用 / 手机端选取」all truncate identically. */
export const TEXT_PREVIEW_CAP = 256 * 1024;

/** Align with desktop / IM attach size ceiling. */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/** The agent-chat send-time attachment payload (mirrors the backend `MessageAttachment` /
 *  desktop `OutgoingAttachment`). Text attachments carry extracted `text`; binary/image
 *  attachments carry `workspace_path` + `binary` with empty `text`. */
export interface MessageAttachment {
  name: string;
  path: string;
  /** The file's text content (UTF-8, capped at {@link TEXT_PREVIEW_CAP}); empty when binary. */
  text: string;
  truncated: boolean;
  kind: "file" | "dir";
  /** Binary / image resident: no UTF-8 body inline. */
  binary?: boolean;
  /** Relative path already written under the conversation workspace (`attachments/…`). */
  workspace_path?: string;
  /**
   * Draft-only: File held until a conversation exists and we PUT.
   * Never serialized onto the wire.
   */
  fileBlob?: File;
}

/** Outcome of reading / staging one picked file: a ready attachment, or a reason it was refused. */
export type ReadAttachmentResult =
  | { ok: true; attachment: MessageAttachment }
  | { ok: false; reason: string };

/** Basename + strip leading dots (align desktop `safeBrowserFileName`). */
export function safeFileName(name: string): string {
  const base = (name || "")
    .replace(/\\/g, "/")
    .trim()
    .split("/")
    .pop()
    ?.replace(/^\.+/, "");
  return base || "attachment";
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i.test(file.name);
}

/** Wire payload: strip draft-only `fileBlob`; omit unset optional flags. */
export function toWireAttachment(
  a: MessageAttachment,
): Omit<MessageAttachment, "fileBlob"> {
  const out: Omit<MessageAttachment, "fileBlob"> = {
    name: a.name,
    path: a.path,
    text: a.binary ? "" : a.text,
    truncated: a.truncated,
    kind: a.kind,
  };
  if (a.binary) out.binary = true;
  if (a.workspace_path) out.workspace_path = a.workspace_path;
  return out;
}

/** True when composer can send: non-blank text, or at least one attachment. */
export function hasSendableDraft(
  text: string,
  attachments: ReadonlyArray<unknown>,
): boolean {
  return Boolean(text.trim()) || attachments.length > 0;
}

/**
 * Stage a user-picked file for agent-chat.
 * - Text: UTF-8 extract, capped at 256KB.
 * - Image / NUL binary: resident-first (`binary` + upload or hold `fileBlob`).
 * Picking the file is the user's explicit grant to read its bytes.
 */
export async function prepareAttachment(
  file: File,
  conversationId: string | null,
): Promise<ReadAttachmentResult> {
  if (file.size > ATTACH_MAX_BYTES) {
    return {
      ok: false,
      reason: `文件超过 ${Math.round(ATTACH_MAX_BYTES / (1024 * 1024))}MB 上限`,
    };
  }

  const name = safeFileName(file.name);
  const image = isImageFile(file);
  const head = await file.slice(0, TEXT_PREVIEW_CAP + 1).arrayBuffer();
  const bytes = new Uint8Array(head);
  const binary = image || bytes.includes(0);

  if (binary) {
    const staged: MessageAttachment = {
      name,
      path: name,
      text: "",
      truncated: false,
      kind: "file",
      binary: true,
      fileBlob: file,
    };
    if (!conversationId) {
      return { ok: true, attachment: staged };
    }
    return ensureAttachmentResident(conversationId, staged);
  }

  const text = new TextDecoder("utf-8").decode(
    bytes.subarray(0, Math.min(bytes.length, TEXT_PREVIEW_CAP)),
  );
  return {
    ok: true,
    attachment: {
      name,
      path: name,
      text,
      truncated: file.size > TEXT_PREVIEW_CAP,
      kind: "file",
    },
  };
}

/**
 * Ensure a staged attachment is resident in the conversation workspace when needed.
 * Already-resident (`workspace_path`) and text-only (no blob) attachments pass through.
 */
export async function ensureAttachmentResident(
  conversationId: string,
  att: MessageAttachment,
): Promise<ReadAttachmentResult> {
  if (att.workspace_path) {
    return {
      ok: true,
      attachment: { ...att, fileBlob: undefined },
    };
  }
  if (!att.binary) {
    return { ok: true, attachment: { ...att, fileBlob: undefined } };
  }
  if (!att.fileBlob) {
    return { ok: false, reason: "二进制附件缺少可上传内容" };
  }

  const name = safeFileName(att.name);
  const workspacePath = `attachments/${crypto.randomUUID()}/${name}`;
  try {
    await uploadWorkspaceFile(conversationId, workspacePath, att.fileBlob);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "上传附件到工作区失败",
    };
  }
  return {
    ok: true,
    attachment: {
      name,
      path: workspacePath,
      text: "",
      truncated: false,
      kind: "file",
      binary: true,
      workspace_path: workspacePath,
    },
  };
}

/** Finalize a list for send: resident upload + wire shape (no `fileBlob`). */
export async function finalizeAttachmentsForSend(
  conversationId: string,
  attachments: MessageAttachment[],
): Promise<
  | { ok: true; attachments: Omit<MessageAttachment, "fileBlob">[] }
  | { ok: false; reason: string }
> {
  const out: Omit<MessageAttachment, "fileBlob">[] = [];
  for (const att of attachments) {
    const res = await ensureAttachmentResident(conversationId, att);
    if (!res.ok) return res;
    out.push(toWireAttachment(res.attachment));
  }
  return { ok: true, attachments: out };
}
