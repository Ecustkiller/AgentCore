import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRootGoneMessage } from "@shared/workspaceRootGone";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceRoot } from "../sidecar/workspace";

describe("resolveWorkspaceRoot（空子路径验盘，scratch 可 mkdir）", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("empty subpath returns existing directory as-is", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-live-"));
    await expect(resolveWorkspaceRoot(dir, "")).resolves.toBe(dir);
  });

  it("empty subpath throws Chinese copy when path is gone", async () => {
    const gone = join(tmpdir(), `ws-gone-${Date.now()}`);
    await expect(resolveWorkspaceRoot(gone, "")).rejects.toThrow(
      workspaceRootGoneMessage(gone),
    );
  });

  it("empty subpath throws when path is a file", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-file-"));
    const file = join(dir, "not-a-dir");
    await writeFile(file, "x");
    await expect(resolveWorkspaceRoot(file, "")).rejects.toThrow(
      workspaceRootGoneMessage(file),
    );
  });

  it("non-empty subpath mkdir even when the nested folder is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-scratch-"));
    const scratch = join(dir, "conversations", "c1");
    const resolved = await resolveWorkspaceRoot(dir, "conversations/c1");
    expect(resolved).toBe(scratch);
    expect((await stat(scratch)).isDirectory()).toBe(true);
  });
});
