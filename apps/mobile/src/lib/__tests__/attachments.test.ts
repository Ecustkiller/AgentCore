import {
  ATTACH_MAX_BYTES,
  ensureAttachmentResident,
  hasSendableDraft,
  prepareAttachment,
  safeFileName,
  toWireAttachment,
} from "@/lib/attachments";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/workspace", () => ({
  uploadWorkspaceFile: vi.fn(),
}));

import { uploadWorkspaceFile } from "@/api/workspace";

const uploadMock = vi.mocked(uploadWorkspaceFile);

function textFile(name: string, body: string, type = "text/plain"): File {
  return new File([body], name, { type });
}

function pngFile(name = "pic.png"): File {
  // PNG magic + NUL-ish binary head so MIME and bytes both look non-text.
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2,
  ]);
  return new File([bytes], name, { type: "image/png" });
}

describe("safeFileName", () => {
  it("strips path and leading dots", () => {
    expect(safeFileName("C:\\\\x\\\\.hid.png")).toBe("hid.png");
    expect(safeFileName("")).toBe("attachment");
  });
});

describe("prepareAttachment", () => {
  beforeEach(() => {
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({
      path: "attachments/x",
      size_bytes: 1,
    });
  });

  it("accepts plain text inline", async () => {
    const res = await prepareAttachment(textFile("a.txt", "hello"), null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachment.text).toBe("hello");
    expect(res.attachment.binary).toBeUndefined();
    expect(res.attachment.fileBlob).toBeUndefined();
  });

  it("stages images as binary without vision hard-reject (draft holds fileBlob)", async () => {
    const file = pngFile();
    const res = await prepareAttachment(file, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachment.binary).toBe(true);
    expect(res.attachment.text).toBe("");
    expect(res.attachment.fileBlob).toBe(file);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("uploads images immediately when conversationId is set", async () => {
    const file = pngFile("shot.jpg");
    const res = await prepareAttachment(file, "conv-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachment.binary).toBe(true);
    expect(res.attachment.workspace_path).toMatch(
      /^attachments\/.+\/shot\.jpg$/,
    );
    expect(res.attachment.fileBlob).toBeUndefined();
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(uploadMock.mock.calls[0]?.[0]).toBe("conv-1");
    expect(uploadMock.mock.calls[0]?.[2]).toBe(file);
  });

  it("does not claim model has no vision in refusal reasons", async () => {
    const huge = new File([new Uint8Array(ATTACH_MAX_BYTES + 1)], "big.png", {
      type: "image/png",
    });
    const res = await prepareAttachment(huge, null);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).not.toMatch(/视觉|vision/i);
  });
});

describe("ensureAttachmentResident / toWireAttachment", () => {
  beforeEach(() => {
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({
      path: "attachments/x",
      size_bytes: 1,
    });
  });

  it("keeps conversation_id on the wire and strips draft-only id", () => {
    const wire = toWireAttachment({
      id: "draft-1",
      name: "上周复盘",
      path: "对话",
      text: "用户: 问",
      truncated: false,
      kind: "conversation",
      conversation_id: "c2",
    });
    expect(wire.kind).toBe("conversation");
    expect(wire.conversation_id).toBe("c2");
    expect("id" in wire && (wire as { id?: string }).id).toBeFalsy();
  });

  it("PUTs draft binary blob and strips fileBlob on the wire shape", async () => {
    const file = pngFile();
    const staged = await prepareAttachment(file, null);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const resided = await ensureAttachmentResident("c2", staged.attachment);
    expect(resided.ok).toBe(true);
    if (!resided.ok) return;
    const wire = toWireAttachment(resided.attachment);
    expect(wire.binary).toBe(true);
    expect(wire.workspace_path).toMatch(/^attachments\//);
    expect(wire.text).toBe("");
    expect(
      "fileBlob" in wire && (wire as { fileBlob?: File }).fileBlob,
    ).toBeFalsy();
  });
});

describe("hasSendableDraft", () => {
  it("allows attachment-only (empty / whitespace text)", () => {
    expect(hasSendableDraft("", [{ name: "a.png" }])).toBe(true);
    expect(hasSendableDraft("  \n", [{ name: "a.png" }])).toBe(true);
  });

  it("requires non-blank text when there are no attachments", () => {
    expect(hasSendableDraft("", [])).toBe(false);
    expect(hasSendableDraft("   ", [])).toBe(false);
    expect(hasSendableDraft("hi", [])).toBe(true);
  });
});
