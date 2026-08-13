/**
 * `killProcessTreeSync` —— 退出钩子用的同步杀树（`process-service` 的 `killAll`）。
 *
 * `before-quit` 之后事件循环未必再转，异步 kill 可能来不及发出；这里验证同步变体
 * 返回时孙进程（后台 `npm run dev` 真正占端口的那一层）也已经停了。
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killProcessTreeSync, treeSpawnOptions } from "../proc-tree";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 孙进程：每 50ms 追加一个字节——文件不再增长 = 它已经停了。 */
const GRANDCHILD_JS = `
const fs = require("node:fs");
const beat = process.argv[2];
setInterval(() => {
  try {
    fs.appendFileSync(beat, ".");
  } catch {}
}, 50);
`;

/** 直接子进程：派生一个在本平台上真能熬过「只杀子进程」的孙进程，然后挂住。 */
const CHILD_JS = `
const { spawn } = require("node:child_process");
const [grandScript, beat] = process.argv.slice(2);
spawn(process.execPath, [grandScript, beat], {
  stdio: "inherit",
  detached: process.platform === "win32",
});
setInterval(() => {}, 1000);
`;

async function beatSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

describe("killProcessTreeSync", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "proc-tree-sync-")));
  });
  afterEach(async () => {
    // Windows：刚被杀的进程还攥着 cwd 句柄一小会儿（rmdir EBUSY），重试几次即可。
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it("reaps grandchildren without handing control back to the event loop", async () => {
    const grandScript = join(dir, "grand.cjs");
    const childScript = join(dir, "child.cjs");
    const beat = join(dir, "beat.txt");
    await writeFile(grandScript, GRANDCHILD_JS, "utf-8");
    await writeFile(childScript, CHILD_JS, "utf-8");

    const child = spawn(process.execPath, [childScript, grandScript, beat], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      ...treeSpawnOptions(),
    });

    // 先证明孙进程真的在跑，否则「已经死了」会空过。
    await sleep(700);
    const aliveA = await beatSize(beat);
    await sleep(300);
    const aliveB = await beatSize(beat);
    expect(aliveA).toBeGreaterThan(0);
    expect(aliveB).toBeGreaterThan(aliveA);

    killProcessTreeSync(child);

    await sleep(500);
    const afterKill = await beatSize(beat);
    await sleep(800);
    expect(await beatSize(beat)).toBe(afterKill);
  }, 30_000);

  it("is a harmless no-op on an already-exited child", async () => {
    const child = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore",
      ...treeSpawnOptions(),
    });
    await new Promise((r) => child.once("close", r));
    expect(() => killProcessTreeSync(child)).not.toThrow();
  }, 15_000);
});
