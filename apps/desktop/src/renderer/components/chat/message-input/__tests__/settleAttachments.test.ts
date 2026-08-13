// @vitest-environment jsdom
/**
 * 发送时收口附件：只等附加阶段那一次上传（绝不重传）、多附件并行、失败带中文原因，
 * 暂存已失效的那几条要被点名摘掉。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../resideAttachment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../resideAttachment")>();
  return { ...actual, ensureAttachmentResident: vi.fn() };
});

import {
  __clearAttachmentUploadsForTests,
  trackAttachmentUpload,
} from "../attachmentUploads";
import type { PendingAttachment } from "../composerAttachments";
import {
  type ResideResult,
  ensureAttachmentResident,
} from "../resideAttachment";
import { settleAttachments } from "../settleAttachments";

const ensure = vi.mocked(ensureAttachmentResident);

function fileAttachment(
  over: Partial<PendingAttachment> = {},
): PendingAttachment {
  return {
    id: over.id ?? "a1",
    key: "dropped:a.png:1",
    name: "a.png",
    path: "a.png",
    text: "",
    truncated: false,
    kind: "file",
    binary: true,
    fileBlob: new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
    ...over,
  };
}

function uploaded(name: string): ResideResult {
  return {
    ok: true,
    name,
    path: `attachments/${name}`,
    text: "",
    truncated: false,
    binary: true,
    workspacePath: `attachments/${name}`,
  };
}

beforeEach(() => {
  __clearAttachmentUploadsForTests();
  ensure.mockReset();
});

describe("settleAttachments", () => {
  it("复用附加时那次上传，不再重传一遍", async () => {
    const att = fileAttachment();
    trackAttachmentUpload(att.id, "c1", Promise.resolve(uploaded("a.png")));

    const res = await settleAttachments("c1", [att]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outgoing).toEqual([
      {
        name: "a.png",
        path: "attachments/a.png",
        text: "",
        truncated: false,
        kind: "file",
        binary: true,
        workspace_path: "attachments/a.png",
      },
    ]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("仍在传就等它落地（不从头重来）", async () => {
    const att = fileAttachment();
    let release!: (r: ResideResult) => void;
    trackAttachmentUpload(
      att.id,
      "c1",
      new Promise<ResideResult>((r) => {
        release = r;
      }),
    );

    const pending = settleAttachments("c1", [att]);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release(uploaded("a.png"));
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("多附件并行收口，不串行等待", async () => {
    const a = fileAttachment({ id: "a1" });
    const b = fileAttachment({
      id: "b1",
      name: "b.png",
      key: "dropped:b.png:1",
    });
    let started = 0;
    ensure.mockImplementation(async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 0));
      return {
        ok: true,
        workspacePath: "attachments/x.png",
        name: "x.png",
        binary: true,
        text: "",
        truncated: false,
      };
    });

    const pending = settleAttachments("c1", [a, b]);
    await Promise.resolve();
    expect(started).toBe(2);
    await pending;
  });

  it("附加时失败的附件在发送时重试一次", async () => {
    const att = fileAttachment();
    trackAttachmentUpload(
      att.id,
      "c1",
      Promise.resolve({ ok: false, reason: "上传附件到云端工作区失败" }),
    );
    ensure.mockResolvedValue({
      ok: true,
      workspacePath: "attachments/a.png",
      name: "a.png",
      binary: true,
      text: "",
      truncated: false,
    });

    const res = await settleAttachments("c1", [att]);

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  it("目标会话对不上（草稿附件发进新建会话）就走兜底驻留", async () => {
    const att = fileAttachment();
    trackAttachmentUpload(att.id, null, Promise.resolve(uploaded("a.png")));
    ensure.mockResolvedValue({
      ok: true,
      workspacePath: "attachments/a.png",
      name: "a.png",
      binary: true,
      text: "",
      truncated: false,
    });

    await settleAttachments("new-conv", [att]);

    expect(ensure).toHaveBeenCalledWith("new-conv", att);
  });

  it("暂存已失效：报中文原因并点名要摘掉的 chip", async () => {
    const att = fileAttachment({ stagingId: "stg-1", fileBlob: undefined });
    ensure.mockResolvedValue({
      ok: false,
      reason: "附件暂存已失效，请重新附加",
    });

    const res = await settleAttachments("c1", [att]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("暂存已失效");
    expect(res.staleIds).toEqual([att.id]);
  });

  it("对话 / 目录这类纯文本引用原样透传，不碰驻留", async () => {
    const conv: PendingAttachment = {
      id: "c-1",
      key: "conversation:conversation:x",
      name: "上次讨论",
      path: "对话",
      text: "用户: hi",
      truncated: false,
      kind: "conversation",
      conversationId: "prev",
    };

    const res = await settleAttachments("c1", [conv]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outgoing[0]).toMatchObject({
      kind: "conversation",
      conversation_id: "prev",
      text: "用户: hi",
    });
    expect(ensure).not.toHaveBeenCalled();
  });
});
