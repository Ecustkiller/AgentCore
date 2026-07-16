import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(""),
  },
}));

import { dialog } from "electron";
import { checkoutArchive, safeJoinUnder } from "../fs/checkout";

const showOpenDialog = dialog.showOpenDialog as unknown as ReturnType<
  typeof vi.fn
>;

describe("safeJoinUnder", () => {
  const dest = join(tmpdir(), "ac-safe-root");

  it("allows nested relative paths", () => {
    expect(safeJoinUnder(dest, "a/b.txt")).toBe(join(dest, "a", "b.txt"));
  });

  it("rejects .. segments", () => {
    expect(safeJoinUnder(dest, "../escape.txt")).toBeNull();
    expect(safeJoinUnder(dest, "a/../../escape.txt")).toBeNull();
  });

  it("rejects null bytes", () => {
    expect(safeJoinUnder(dest, "a\0b.txt")).toBeNull();
  });
});

describe("checkoutArchive", () => {
  let destDir: string;

  beforeEach(async () => {
    destDir = await fs.mkdtemp(join(tmpdir(), "ac-checkout-"));
    showOpenDialog.mockReset();
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [destDir],
    });
  });

  afterEach(async () => {
    await fs.rm(destDir, { recursive: true, force: true });
  });

  it("extracts zip entries into the picked directory", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    zip.file("sub/a.md", "# a");
    const archiveBase64 = await zip.generateAsync({ type: "base64" });

    const result = await checkoutArchive(archiveBase64);
    expect(result).toEqual({
      ok: true,
      destName: expect.any(String),
      fileCount: 2,
    });
    expect(await fs.readFile(join(destDir, "hello.txt"), "utf-8")).toBe("hi");
    expect(await fs.readFile(join(destDir, "sub", "a.md"), "utf-8")).toBe(
      "# a",
    );
  });

  it("returns cancelled when dialog is dismissed", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const result = await checkoutArchive("AAAA");
    expect(result).toEqual({ ok: false, reason: "cancelled" });
  });
});
