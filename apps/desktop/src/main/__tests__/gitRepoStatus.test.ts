import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGitStatusSb } from "../fs/workspace/gitRepoStatus";
import {
  evaluateDiscardPath,
  evaluateDiscardPaths,
  evaluatePushGuard,
  parseGitScmAction,
} from "../fs/workspace/gitScm";

describe("parseGitStatusSb", () => {
  it("parses branch ahead of remote", () => {
    expect(parseGitStatusSb("## main...origin/main [ahead 1]\n")).toEqual({
      branch: "main",
      dirty: false,
      ahead: 1,
      behind: 0,
      staged: [],
      unstaged: [],
      conflicted: [],
    });
  });

  it("parses ahead and behind", () => {
    const r = parseGitStatusSb(
      "## feature/x...origin/feature/x [ahead 2, behind 1]\n",
    );
    expect(r.branch).toBe("feature/x");
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(1);
  });

  it("marks dirty and splits staged/unstaged", () => {
    const r = parseGitStatusSb("## feature/x\nM  a.ts\n M b.ts\n?? c.ts\n");
    expect(r).toMatchObject({
      branch: "feature/x",
      dirty: true,
    });
    expect(r.staged).toEqual([{ path: "a.ts", code: "M " }]);
    expect(r.unstaged).toEqual([
      { path: "b.ts", code: " M" },
      { path: "c.ts", code: "??" },
    ]);
  });

  it("collects conflicted paths", () => {
    const r = parseGitStatusSb("## main\nUU conflict.ts\n");
    expect(r.conflicted).toEqual(["conflict.ts"]);
    expect(r.staged).toEqual([]);
    expect(r.unstaged).toEqual([]);
  });

  it("handles no-commits-yet line", () => {
    expect(parseGitStatusSb("## No commits yet on main\n")).toEqual({
      branch: "main",
      dirty: false,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      conflicted: [],
    });
  });

  it("handles detached HEAD", () => {
    expect(parseGitStatusSb("## HEAD (no branch)\n").branch).toBe("HEAD");
  });

  it("empty stdout → placeholder branch", () => {
    expect(parseGitStatusSb("").branch).toBe("(无)");
  });
});

describe("gitScm guards", () => {
  it("parses known actions", () => {
    expect(parseGitScmAction("stage")).toBe("stage");
    expect(parseGitScmAction("PUSH")).toBe("push");
    expect(parseGitScmAction("discard")).toBe("discard");
    expect(parseGitScmAction("fetch")).toBe("fetch");
    expect(parseGitScmAction("reset")).toBeNull();
    expect(parseGitScmAction("clean")).toBeNull();
  });

  it("denies force / protected branch push", () => {
    expect(
      evaluatePushGuard({
        branch: "feature",
        remote: "origin",
        args: { force: true },
      }),
    ).toMatch(/force/i);
    expect(
      evaluatePushGuard({
        branch: "main",
        remote: "origin",
        args: {},
      }),
    ).toMatch(/main\/master/);
    expect(
      evaluatePushGuard({
        branch: "feature",
        remote: "origin",
        args: {},
      }),
    ).toBeNull();
  });

  it("discard path guard rejects empty, dash, traversal, absolute", () => {
    expect(evaluateDiscardPath("")).toMatch(/空/);
    expect(evaluateDiscardPath("  ")).toMatch(/空/);
    expect(evaluateDiscardPath("-n")).toMatch(/-/);
    expect(evaluateDiscardPath("--worktree")).toMatch(/-/);
    expect(evaluateDiscardPath("../x")).toMatch(/\.\./);
    expect(evaluateDiscardPath("foo/../bar")).toMatch(/\.\./);
    expect(evaluateDiscardPath("/etc/passwd")).toMatch(/绝对/);
    expect(evaluateDiscardPath("C:/Windows/system32")).toMatch(/绝对/);
    expect(evaluateDiscardPath("a.ts")).toEqual({ path: "a.ts" });
    expect(evaluateDiscardPath("src\\a.ts")).toEqual({ path: "src/a.ts" });

    expect(evaluateDiscardPaths(undefined)).toMatchObject({
      error: expect.stringMatching(/必须指定 paths/),
    });
    expect(evaluateDiscardPaths([])).toMatchObject({
      error: expect.stringMatching(/必须指定 paths/),
    });
    expect(evaluateDiscardPaths(["ok.ts", "../evil"])).toMatchObject({
      error: expect.stringMatching(/\.\./),
    });
    expect(evaluateDiscardPaths(["a.ts", "b.ts"])).toEqual({
      paths: ["a.ts", "b.ts"],
    });
  });
});

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  shell: { trashItem: async () => {} },
}));

describe("executeWorkspaceOp git_repo_status + git_scm", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "git-u2-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns present:false when workspace root has no .git", async () => {
    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };
    const r = await executeWorkspaceOp(root, "git_repo_status", {});
    expect(r).toEqual({ ok: true, value: { present: false } });
  });

  it("lists staged/unstaged and can stage→commit on feature branch", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    await execFileAsync("git", ["init"], { cwd: dir, windowsHide: true });
    try {
      await execFileAsync("git", ["checkout", "-b", "feature/u2"], {
        cwd: dir,
        windowsHide: true,
      });
    } catch {
      // already on a branch
    }
    await execFileAsync("git", ["config", "user.email", "u2@test"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.name", "u2"], {
      cwd: dir,
      windowsHide: true,
    });
    await writeFile(join(dir, "a.txt"), "a\n", "utf-8");
    await execFileAsync("git", ["add", "a.txt"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["commit", "-m", "init"], {
      cwd: dir,
      windowsHide: true,
    });
    // ensure feature branch (not main) for push guard coverage later
    try {
      await execFileAsync("git", ["checkout", "-B", "feature/u2"], {
        cwd: dir,
        windowsHide: true,
      });
    } catch {
      // ignore
    }
    await writeFile(join(dir, "a.txt"), "dirty\n", "utf-8");
    await writeFile(join(dir, "b.txt"), "new\n", "utf-8");

    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };
    const status = await executeWorkspaceOp(root, "git_repo_status", {});
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const value = status.value as {
      present: boolean;
      dirty?: boolean;
      unstaged?: { path: string }[];
    };
    expect(value.present).toBe(true);
    expect(value.dirty).toBe(true);
    expect((value.unstaged ?? []).some((e) => e.path === "a.txt")).toBe(true);

    const stage = await executeWorkspaceOp(root, "git_scm", {
      action: "stage",
      paths: ["a.txt", "b.txt"],
    });
    expect(stage.ok).toBe(true);

    const afterStage = await executeWorkspaceOp(root, "git_repo_status", {});
    expect(afterStage.ok).toBe(true);
    if (!afterStage.ok) return;
    const stagedVal = afterStage.value as {
      staged?: { path: string }[];
    };
    expect((stagedVal.staged ?? []).map((e) => e.path).sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);

    const commit = await executeWorkspaceOp(root, "git_scm", {
      action: "commit",
      message: "u2 commit",
    });
    expect(commit.ok).toBe(true);

    const pushDenied = await executeWorkspaceOp(root, "git_scm", {
      action: "push",
      force: true,
    });
    expect(pushDenied.ok).toBe(false);
  });

  it("discards unstaged tracked worktree changes; rejects pathless discard", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { readFile } = await import("node:fs/promises");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    await execFileAsync("git", ["init"], { cwd: dir, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "u2@test"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.name", "u2"], {
      cwd: dir,
      windowsHide: true,
    });
    await writeFile(join(dir, "a.txt"), "base\n", "utf-8");
    await execFileAsync("git", ["add", "a.txt"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["commit", "-m", "init"], {
      cwd: dir,
      windowsHide: true,
    });
    // staged+unstaged：discard 应回到索引（staged），不是 HEAD
    await writeFile(join(dir, "a.txt"), "staged\n", "utf-8");
    await execFileAsync("git", ["add", "a.txt"], {
      cwd: dir,
      windowsHide: true,
    });
    await writeFile(join(dir, "a.txt"), "dirty\n", "utf-8");

    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };

    const denied = await executeWorkspaceOp(root, "git_scm", {
      action: "discard",
    });
    expect(denied.ok).toBe(false);

    const traversal = await executeWorkspaceOp(root, "git_scm", {
      action: "discard",
      paths: ["../outside.txt"],
    });
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) {
      expect(traversal.error.detail).toMatch(/\.\./);
    }

    const absolute = await executeWorkspaceOp(root, "git_scm", {
      action: "discard",
      paths: ["/etc/passwd"],
    });
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) {
      expect(absolute.error.detail).toMatch(/绝对/);
    }

    const dashOpt = await executeWorkspaceOp(root, "git_scm", {
      action: "discard",
      paths: ["--worktree"],
    });
    expect(dashOpt.ok).toBe(false);

    const discarded = await executeWorkspaceOp(root, "git_scm", {
      action: "discard",
      paths: ["a.txt"],
    });
    expect(discarded.ok).toBe(true);
    const restored = (await readFile(join(dir, "a.txt"), "utf-8")).replace(
      /\r\n/g,
      "\n",
    );
    expect(restored).toBe("staged\n");
  });

  it("fetch rejects prune knobs and missing remote", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    await execFileAsync("git", ["init"], { cwd: dir, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "u2@test"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.name", "u2"], {
      cwd: dir,
      windowsHide: true,
    });

    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };

    const noRemote = await executeWorkspaceOp(root, "git_scm", {
      action: "fetch",
    });
    expect(noRemote.ok).toBe(false);

    const pruned = await executeWorkspaceOp(root, "git_scm", {
      action: "fetch",
      prune: true,
    });
    expect(pruned.ok).toBe(false);
  });

  it("refuses push from main", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    await execFileAsync("git", ["init"], { cwd: dir, windowsHide: true });
    await execFileAsync("git", ["checkout", "-b", "main"], {
      cwd: dir,
      windowsHide: true,
    }).catch(() => undefined);
    await execFileAsync("git", ["config", "user.email", "u2@test"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.name", "u2"], {
      cwd: dir,
      windowsHide: true,
    });
    await writeFile(join(dir, "a.txt"), "a\n", "utf-8");
    await execFileAsync("git", ["add", "a.txt"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["commit", "-m", "init"], {
      cwd: dir,
      windowsHide: true,
    });
    // Ensure we're on main
    await execFileAsync("git", ["checkout", "-B", "main"], {
      cwd: dir,
      windowsHide: true,
    }).catch(() => undefined);
    await execFileAsync("git", ["remote", "add", "origin", dir], {
      cwd: dir,
      windowsHide: true,
    }).catch(() => undefined);

    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };
    const push = await executeWorkspaceOp(root, "git_scm", {
      action: "push",
    });
    expect(push.ok).toBe(false);
    if (push.ok) return;
    expect(push.error.detail).toMatch(/main\/master/);
  });
});
