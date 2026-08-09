/**
 * Desktop ``git_run`` — Agent structured git handler + argv guards.
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateGitRunArgv } from "../fs/workspace/gitRun";

describe("evaluateGitRunArgv", () => {
  it("requires non-empty string argv", () => {
    expect(evaluateGitRunArgv(undefined)).toMatch(/argv/);
    expect(evaluateGitRunArgv([])).toMatch(/argv/);
    expect(evaluateGitRunArgv([1])).toMatch(/字符串/);
  });

  it("rejects reset / clean", () => {
    expect(evaluateGitRunArgv(["reset", "--hard"])).toMatch(/reset/);
    expect(evaluateGitRunArgv(["clean", "-fd"])).toMatch(/clean/);
  });

  it("rejects force push tokens", () => {
    expect(evaluateGitRunArgv(["push", "--force"])).toMatch(/force/);
    expect(evaluateGitRunArgv(["push", "-f"])).toMatch(/force/);
    expect(evaluateGitRunArgv(["push", "--force-with-lease"])).toMatch(/force/);
  });

  it("rejects git-dir / work-tree boundary overrides", () => {
    expect(evaluateGitRunArgv(["status", "--git-dir=/tmp/x"])).toMatch(/边界/);
    expect(evaluateGitRunArgv(["--work-tree=.", "status"])).toMatch(/边界/);
  });

  it("allows ordinary status / log", () => {
    expect(evaluateGitRunArgv(["status", "-sb"])).toBeNull();
    expect(evaluateGitRunArgv(["log", "-n", "5", "--oneline"])).toBeNull();
  });
});

describe("executeWorkspaceOp git_run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "git-run-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns hard error envelope for forbidden argv", async () => {
    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };
    const r = await executeWorkspaceOp(root, "git_run", {
      argv: ["reset", "--hard"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.detail).toMatch(/reset/);
  });

  it("runs status in a real repo and returns exit_code triple", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    await execFileAsync("git", ["init", "-b", "feature/run"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.email", "run@test"], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync("git", ["config", "user.name", "run"], {
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

    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };
    const r = await executeWorkspaceOp(root, "git_run", {
      argv: ["status", "-sb"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const value = r.value as {
      stdout: string;
      stderr: string;
      exit_code: number;
    };
    expect(value.exit_code).toBe(0);
    expect(value.stdout).toMatch(/feature\/run/);
  });

  it("returns non-zero exit_code in ok envelope when git fails", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    // No .git — rev-parse should fail with non-zero; still ok:true + exit_code.
    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };
    const r = await executeWorkspaceOp(root, "git_run", {
      argv: ["rev-parse", "--is-inside-work-tree"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const value = r.value as { exit_code: number; stderr: string };
    expect(value.exit_code).not.toBe(0);
  });

  it("runs git under cwd subpath, not the shared container root", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdir, access } = await import("node:fs/promises");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("git", ["--version"], { windowsHide: true });
    } catch {
      return;
    }
    const proj = join(dir, "projA");
    await mkdir(proj, { recursive: true });

    const { executeWorkspaceOp } = await import("../fs-service");
    const root = { id: "r", name: "r", absPath: dir };
    const init = await executeWorkspaceOp(root, "git_run", {
      argv: ["init", "-b", "main"],
      cwd: "projA",
    });
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    expect((init.value as { exit_code: number }).exit_code).toBe(0);

    await access(join(proj, ".git"));
    await expect(access(join(dir, ".git"))).rejects.toBeTruthy();
  });

  it("resolveGitRunCwd rejects traversal and keeps empty at root", async () => {
    const { resolveGitRunCwd } = await import("../fs/workspace/gitRun");
    const root = { id: "r", name: "r", absPath: dir };
    const atRoot = await resolveGitRunCwd(root, "");
    expect(atRoot.ok).toBe(true);
    if (atRoot.ok) expect(atRoot.cwd).toBe(dir);

    const bad = await resolveGitRunCwd(root, "../outside");
    expect(bad.ok).toBe(false);
  });
});
