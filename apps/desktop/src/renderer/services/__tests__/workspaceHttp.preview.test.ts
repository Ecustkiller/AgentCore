// @vitest-environment jsdom

import { decodePreviewResponse } from "@/services/workspaceHttp";
import { describe, expect, it } from "vitest";

function fakeResponse(
  body: Uint8Array | string,
  init?: { contentType?: string; contentLength?: number },
): Response {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers = new Headers();
  if (init?.contentType) headers.set("content-type", init.contentType);
  headers.set(
    "content-length",
    String(init?.contentLength ?? bytes.byteLength),
  );
  return new Response(bytes as BodyInit, { status: 200, headers });
}

describe("decodePreviewResponse — cloud image / text", () => {
  it("Content-Type image/* → kind image data URL", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = await decodePreviewResponse(
      fakeResponse(png, { contentType: "image/png" }),
      { path: "shots/a.png" },
    );
    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.mime).toBe("image/png");
      expect(result.size).toBe(png.length);
      expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("octet-stream + .jpg path → still image (MIME fallback)", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const result = await decodePreviewResponse(
      fakeResponse(jpeg, { contentType: "application/octet-stream" }),
      { path: "photo.jpg" },
    );
    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.mime).toBe("image/jpeg");
    }
  });

  it("oversized image (content-length) → binary with reason, no body consume required", async () => {
    const result = await decodePreviewResponse(
      fakeResponse(new Uint8Array([1]), {
        contentType: "image/png",
        contentLength: 11 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({
      kind: "binary",
      mime: "image/png",
      size: 11 * 1024 * 1024,
      reason: "图片过大（超过 10MB），请下载或用系统默认程序打开",
    });
  });

  it("NUL text bytes without image MIME → binary with open/download reason", async () => {
    const result = await decodePreviewResponse(
      fakeResponse(new Uint8Array([0x00, 0x01, 0x02]), {
        contentType: "application/octet-stream",
      }),
      { path: "blob.bin" },
    );
    expect(result).toEqual({
      kind: "binary",
      reason: "无法在面板内预览，请下载或用系统默认程序打开",
    });
  });

  it("application/pdf → kind pdf data URL", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    const result = await decodePreviewResponse(
      fakeResponse(pdf, { contentType: "application/pdf" }),
      { path: "docs/a.pdf" },
    );
    expect(result.kind).toBe("pdf");
    if (result.kind === "pdf") {
      expect(result.mime).toBe("application/pdf");
      expect(result.size).toBe(pdf.length);
      expect(result.dataUrl.startsWith("data:application/pdf;base64,")).toBe(
        true,
      );
    }
  });

  it("octet-stream + .pdf path → still pdf", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const result = await decodePreviewResponse(
      fakeResponse(pdf, { contentType: "application/octet-stream" }),
      { path: "report.pdf" },
    );
    expect(result.kind).toBe("pdf");
    if (result.kind === "pdf") {
      expect(result.mime).toBe("application/pdf");
    }
  });

  it("oversized PDF (content-length) → binary with reason", async () => {
    const result = await decodePreviewResponse(
      fakeResponse(new Uint8Array([1]), {
        contentType: "application/pdf",
        contentLength: 16 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({
      kind: "binary",
      mime: "application/pdf",
      size: 16 * 1024 * 1024,
      reason: "PDF 过大（超过 15MB），请下载或用系统默认程序打开",
    });
  });

  it("plain UTF-8 → text", async () => {
    const result = await decodePreviewResponse(
      fakeResponse("hello\nworld", { contentType: "text/plain" }),
      { path: "notes.txt" },
    );
    expect(result).toEqual({
      kind: "text",
      text: "hello\nworld",
      truncated: false,
    });
  });

  it("text over 256KiB display cap → truncated (aligned with local TEXT_PREVIEW_CAP)", async () => {
    const body = "a".repeat(256 * 1024 + 50);
    const result = await decodePreviewResponse(
      fakeResponse(body, { contentType: "text/plain" }),
      { path: "big.txt" },
    );
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(256 * 1024);
    }
  });
});
