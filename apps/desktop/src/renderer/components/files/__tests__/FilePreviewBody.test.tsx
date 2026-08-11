// @vitest-environment jsdom

import { FilePreviewBody } from "@/components/files/FilePreviewBody";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("FilePreviewBody", () => {
  it("image: shows mime·size, zoom controls, and opens lightbox on click", () => {
    render(
      <FilePreviewBody
        name="shot.png"
        result={{
          kind: "image",
          dataUrl: "data:image/png;base64,AAAA",
          mime: "image/png",
          size: 1280,
        }}
      />,
    );

    expect(screen.getByText(/image\/png/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "放大" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "缩小" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "放大预览 shot.png" }));
    expect(screen.getByRole("dialog", { name: "shot.png" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "shot.png" })).toBeNull();
  });

  it("pdf: renders iframe with data URL and footer meta", () => {
    const { container } = render(
      <FilePreviewBody
        name="doc.pdf"
        result={{
          kind: "pdf",
          dataUrl: "data:application/pdf;base64,JVBERg==",
          mime: "application/pdf",
          size: 4096,
        }}
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("src")).toBe(
      "data:application/pdf;base64,JVBERg==",
    );
    expect(iframe?.getAttribute("title")).toBe("doc.pdf");
    expect(screen.getByText(/application\/pdf/)).toBeTruthy();
  });

  it("too-large / binary: clearer download-or-open copy", () => {
    const { rerender } = render(
      <FilePreviewBody name="big.bin" result={{ kind: "too-large" }} />,
    );
    expect(
      screen.getByText(
        "文件过大，不在面板内预览，请下载或用系统默认程序打开。",
      ),
    ).toBeTruthy();

    rerender(
      <FilePreviewBody
        name="sheet.xlsx"
        result={{
          kind: "binary",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 2048,
          reason: "无法在面板内预览，请下载或用系统默认程序打开",
        }}
      />,
    );
    expect(screen.getByText("无法预览此文件")).toBeTruthy();
    expect(
      screen.getByText("无法在面板内预览，请下载或用系统默认程序打开"),
    ).toBeTruthy();
  });
});
