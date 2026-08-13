/**
 * 桌面本地执行：杀树失败也必须在硬上限内回话。
 *
 * 真实孤儿攥着 stdout 时 `close` 永不触发；这里把 `killProcessTree` 换成不杀的桩来
 * 稳定复现那种局面（跨平台都走到宽限计时器），确保 op 不会挂到超时之后——`test_run`
 * 的灾难顶是 20 分钟。
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../proc-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../proc-tree")>();
  return { ...actual, killProcessTree: vi.fn(async () => {}) };
});

import { runSubprocess } from "../fs/workspace/exec";
import { killProcessTree } from "../proc-tree";

interface ExecValue {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

function execValue(res: WorkspaceOpResult): ExecValue {
  if (!res.ok) throw new Error(`expected ok envelope, got ${res.error.kind}`);
  return res.value as ExecValue;
}

/** 活得远比测试久的进程：只要 op 早于它退出就说明走的是宽限计时器，不是 `close`。 */
const SURVIVOR_JS = (pidFile: string): string => `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => process.exit(0), 60000);
`;

describe("runSubprocess bounded answer when the tree survives", () => {
  let dir: string;
  let pidFile: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "exec-kill-grace-")));
    pidFile = join(dir, "pid.txt");
    vi.mocked(killProcessTree).mockClear();
  });
  afterEach(async () => {
    // 桩掉了杀树，得自己收尸——测试中途失败也不留 60s 的幸存者。
    try {
      const pid = Number((await readFile(pidFile, "utf-8")).trim());
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      /* 没起来，或已经没了 */
    }
    // Windows：刚被杀的进程还攥着 cwd 句柄一小会儿（rmdir EBUSY），重试几次即可。
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it("answers with the timeout envelope even if the kill does nothing", async () => {
    const script = join(dir, "survivor.cjs");
    await writeFile(script, SURVIVOR_JS(pidFile), "utf-8");

    const startedMs = Date.now();
    const value = execValue(
      await runSubprocess([process.execPath], script, dir, null, 2, startedMs),
    );
    const elapsed = Date.now() - startedMs;

    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(value.exit_code).toBe(-1);
    expect(value.stderr).toBe("Timeout: forced stop after 2s (forced stop)");
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    // 子进程还活着（60s 才退），所以这次返回只能来自宽限上限。
    expect(elapsed).toBeLessThan(8_000);
    // 幸存者确实还在（afterEach 负责收尸）——否则「有界」是靠 close 蒙对的。
    const pid = Number((await readFile(pidFile, "utf-8")).trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 30_000);
});
