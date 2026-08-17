import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { type StoredRoot, setRoot } from "../fs/roots";
import { collectWorkspaceFiles, listFiles } from "../fs/tree";

describe("listFiles / collectWorkspaceFiles", () => {
  let dir: string;
  let root: StoredRoot;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "list-files-")));
    root = { id: "lf-root", name: "lf", absPath: dir };
    setRoot(root);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("honors root .gitignore and still returns dot dirs like .cursor", async () => {
    await writeFile(join(dir, "keep.txt"), "k");
    await writeFile(join(dir, "secret.txt"), "s");
    await writeFile(join(dir, ".gitignore"), "secret.txt\nignored-dir/\n");
    await mkdir(join(dir, "ignored-dir"), { recursive: true });
    await writeFile(join(dir, "ignored-dir", "hidden.md"), "h");
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(join(dir, ".cursor", "rules.md"), "r");
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "x");

    const collected = await collectWorkspaceFiles(dir);
    expect(collected.truncated).toBe(false);
    expect(collected.files.map((f) => f.relPath)).toEqual([
      ".cursor/rules.md",
      ".gitignore",
      "keep.txt",
    ]);

    const listed = await listFiles(root.id);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.truncated).toBe(false);
    expect(listed.data.files.map((f) => f.relPath)).toEqual([
      ".cursor/rules.md",
      ".gitignore",
      "keep.txt",
    ]);
    expect(listed.data.files.every((f) => f.mtimeMs === undefined)).toBe(true);
  });

  it("surfaces truncated when the listing cap is hit", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.txt"), "b");
    await writeFile(join(dir, "c.txt"), "c");

    const collected = await collectWorkspaceFiles(dir, "path", { cap: 2 });
    expect(collected.truncated).toBe(true);
    expect(collected.files).toHaveLength(2);

    const listed = await listFiles(root.id, { cap: 2 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.truncated).toBe(true);
    expect(listed.data.files).toHaveLength(2);
  });

  it("listFiles order=recent returns newest-first", async () => {
    await writeFile(join(dir, "a_old.txt"), "A");
    await writeFile(join(dir, "c_mid.txt"), "C");
    await writeFile(join(dir, "b_new.txt"), "B");
    await utimes(join(dir, "a_old.txt"), 100, 100);
    await utimes(join(dir, "c_mid.txt"), 200, 200);
    await utimes(join(dir, "b_new.txt"), 300, 300);

    const recent = await listFiles(root.id, { order: "recent" });
    expect(recent.ok).toBe(true);
    if (!recent.ok) return;
    expect(recent.data.truncated).toBe(false);
    expect(recent.data.files).toEqual([
      { relPath: "b_new.txt", name: "b_new.txt", mtimeMs: 300_000 },
      { relPath: "c_mid.txt", name: "c_mid.txt", mtimeMs: 200_000 },
      { relPath: "a_old.txt", name: "a_old.txt", mtimeMs: 100_000 },
    ]);

    const alpha = await listFiles(root.id);
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) return;
    expect(alpha.data.files).toEqual([
      { relPath: "a_old.txt", name: "a_old.txt" },
      { relPath: "b_new.txt", name: "b_new.txt" },
      { relPath: "c_mid.txt", name: "c_mid.txt" },
    ]);
  });
});
