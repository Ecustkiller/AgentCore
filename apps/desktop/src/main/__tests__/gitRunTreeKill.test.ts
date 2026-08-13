/**
 * Desktop ``git_run`` timeout path — kills the whole process tree.
 *
 * Stands in for git with a node process that spawns a grandchild the way git
 * spawns ``git-remote-https`` (inheriting the stdout pipe). Before the fix the
 * grandchild survived the timeout, kept ``.git/index.lock``, and every later call
 * timed out on the same lock.
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitCapture } from "../fs/workspace/gitRun";
import { killProcessTree, treeSpawnOptions } from "../proc-tree";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Grandchild: append a byte every 50ms — a frozen file means it stopped running. */
const GRANDCHILD_JS = `
const fs = require("node:fs");
const beat = process.argv[2];
setInterval(() => {
  try {
    fs.appendFileSync(beat, ".");
  } catch {}
}, 50);
`;

/**
 * Child: emit stdout, spawn the grandchild holding the same pipes, then hang.
 *
 * The grandchild is spawned in the shape that actually *survives* killing the
 * direct child on this platform — otherwise the test would pass without the tree
 * kill. POSIX: a plain child of git (``git-remote-https``) is never signalled when
 * git dies, and it stays in git's process group where ``killpg`` reaches it.
 * Windows: an ordinary grandchild dies with the hidden console its parent owned,
 * so the survivor to model is a detached helper (credential/askpass style), which
 * ``taskkill /T`` still reaches through the recorded parent link.
 */
const CHILD_JS = `
const { spawn } = require("node:child_process");
const [grandScript, beat] = process.argv.slice(2);
const detached = process.platform === "win32";
spawn(process.execPath, [grandScript, beat], { stdio: "inherit", detached });
process.stdout.write("partial-stdout\\n");
setInterval(() => {}, 1000);
`;

async function beatSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

describe("runGitCapture timeout", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "git-tree-kill-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("kills grandchildren and still returns the stdout received so far", async () => {
    const grandScript = join(dir, "grand.cjs");
    const childScript = join(dir, "child.cjs");
    const beat = join(dir, "beat.txt");
    await writeFile(grandScript, GRANDCHILD_JS, "utf-8");
    await writeFile(childScript, CHILD_JS, "utf-8");

    const startedMs = Date.now();
    const running = runGitCapture(
      process.execPath,
      [childScript, grandScript, beat],
      dir,
      2_000,
    );

    // Prove the grandchild is actually running, so "it died" cannot pass vacuously.
    await sleep(700);
    const aliveA = await beatSize(beat);
    await sleep(300);
    const aliveB = await beatSize(beat);
    expect(aliveA).toBeGreaterThan(0);
    expect(aliveB).toBeGreaterThan(aliveA);

    const res = await running;
    // Bounded: the kill grace must not let the op outlive timeout + slack.
    expect(Date.now() - startedMs).toBeLessThan(8_000);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/git 操作超时/);
    expect(res.stdout).toContain("partial-stdout");

    await sleep(500);
    const afterKill = await beatSize(beat);
    await sleep(800);
    expect(await beatSize(beat)).toBe(afterKill);
  }, 30_000);

  it("passes through exit code and stdout when the child finishes", async () => {
    const res = await runGitCapture(
      process.execPath,
      ["-e", "process.stdout.write('hi'); process.exit(3)"],
      dir,
      10_000,
    );
    expect(res).toEqual({ stdout: "hi", stderr: "", code: 3 });
  });

  it("reports a failed spawn as a non-zero envelope instead of throwing", async () => {
    const res = await runGitCapture(join(dir, "no-such-bin"), [], dir, 5_000);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it("killProcessTree is a harmless no-op on an already-exited child", async () => {
    const child = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore",
      ...treeSpawnOptions(),
    });
    await new Promise((r) => child.once("close", r));
    await expect(killProcessTree(child)).resolves.toBeUndefined();
  });
});
