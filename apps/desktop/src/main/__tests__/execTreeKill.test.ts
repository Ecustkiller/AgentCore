/**
 * 桌面本地 `code_execute` / `test_run` 超时路径 —— 杀掉整棵进程树。
 *
 * 用一个自己派生孙进程的 node 脚本冒充 AI 写的脚本（`npm run dev`、无头浏览器…）。
 * 修复前只 SIGKILL 解释器本身：孙进程变孤儿留在用户机器上占端口占 CPU，还攥着
 * stdout 让 `close` 永不触发。两条超时（灾难顶 / 静默活性）各测一次。
 */
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSubprocess } from "../fs/workspace/exec";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface ExecValue {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

function execValue(res: WorkspaceOpResult): ExecValue {
  if (!res.ok) throw new Error(`expected ok envelope, got ${res.error.kind}`);
  return res.value as ExecValue;
}

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

/**
 * 被执行的「AI 脚本」：派生一个持有同一批 pipe 的孙进程，然后挂住不退。
 *
 * 孙进程按**本平台上真能熬过「只杀直接子进程」**的形态派生，否则没有杀树也能过测。
 * POSIX：解释器的普通子进程不会随它一起收到信号，且留在同一进程组里等着 `killpg`。
 * Windows：普通孙进程会随父进程的控制台一起消失，所以要模拟的幸存者是 detached
 * 助手（credential / askpass 那类），`taskkill /T` 仍能顺父子链找到它。
 *
 * `runSubprocess` 只接受 `[bin, ...preArgs, scriptFile]`，脚本拿不到额外 argv，
 * 因此路径直接写进脚本文本。
 */
function childSource(
  grandScript: string,
  beat: string,
  opts: { emitStdout: boolean },
): string {
  return `
const { spawn } = require("node:child_process");
spawn(process.execPath, [${JSON.stringify(grandScript)}, ${JSON.stringify(beat)}], {
  stdio: "inherit",
  detached: process.platform === "win32",
});
${opts.emitStdout ? 'process.stdout.write("partial-stdout\\n");' : ""}
setInterval(() => {}, 1000);
`;
}

async function beatSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

describe("runSubprocess timeout kills the process tree", () => {
  let dir: string;
  let grandScript: string;
  let childScript: string;
  let beat: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "exec-tree-kill-")));
    grandScript = join(dir, "grand.cjs");
    childScript = join(dir, "child.cjs");
    beat = join(dir, "beat.txt");
    await writeFile(grandScript, GRANDCHILD_JS, "utf-8");
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

  /** 先证明孙进程真的在跑，再证明它死了——否则「已经死了」会空过。 */
  async function expectHeartbeatAlive(): Promise<void> {
    await sleep(700);
    const a = await beatSize(beat);
    await sleep(300);
    const b = await beatSize(beat);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  }

  async function expectHeartbeatStopped(): Promise<void> {
    await sleep(500);
    const afterKill = await beatSize(beat);
    await sleep(800);
    expect(await beatSize(beat)).toBe(afterKill);
  }

  it("disaster wall: kills grandchildren, keeps the forced-stop envelope", async () => {
    await writeFile(
      childScript,
      childSource(grandScript, beat, { emitStdout: true }),
      "utf-8",
    );

    const startedMs = Date.now();
    const running = runSubprocess(
      [process.execPath],
      childScript,
      dir,
      null,
      2,
      startedMs,
    );

    await expectHeartbeatAlive();

    const value = execValue(await running);
    // 有界：孤儿攥着 pipe 也不能让 op 拖在超时之后。
    expect(Date.now() - startedMs).toBeLessThan(8_000);
    expect(value.success).toBe(false);
    expect(value.exit_code).toBe(-1);
    expect(value.stderr).toBe("Timeout: forced stop after 2s (forced stop)");
    // 契约：超时信封清空 stdout（与服务端 SubprocessSandbox 一致）。
    expect(value.stdout).toBe("");
    expect(value.duration_ms).toBeGreaterThanOrEqual(2_000);

    await expectHeartbeatStopped();
  }, 30_000);

  it("idle wall: kills grandchildren, keeps the stalled envelope", async () => {
    await writeFile(
      childScript,
      childSource(grandScript, beat, { emitStdout: false }),
      "utf-8",
    );

    const startedMs = Date.now();
    const running = runSubprocess(
      [process.execPath],
      childScript,
      dir,
      null,
      30,
      startedMs,
      undefined,
      2,
    );

    await expectHeartbeatAlive();

    const value = execValue(await running);
    expect(Date.now() - startedMs).toBeLessThan(10_000);
    expect(value.success).toBe(false);
    expect(value.exit_code).toBe(-1);
    expect(value.stderr).toBe("Timeout: no output for 2s (execution stalled)");
    expect(value.stdout).toBe("");

    await expectHeartbeatStopped();
  }, 30_000);
});

describe("runSubprocess normal path", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "exec-normal-")));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 新进程组 / detached 不能把 stdin 管道弄丢——本地执行要往里写 `args.stdin`。 */
  it("still pipes stdin in and exit code out", async () => {
    const script = join(dir, "echo.cjs");
    await writeFile(
      script,
      `
let data = "";
process.stdin.on("data", (c) => { data += c; });
process.stdin.on("end", () => {
  process.stdout.write("got:" + data);
  process.exit(7);
});
`,
      "utf-8",
    );

    const value = execValue(
      await runSubprocess(
        [process.execPath],
        script,
        dir,
        "ping",
        15,
        Date.now(),
      ),
    );
    expect(value.stdout).toBe("got:ping");
    expect(value.exit_code).toBe(7);
    expect(value.success).toBe(false);
  }, 30_000);

  it("reports a failed spawn as a result envelope instead of throwing", async () => {
    const value = execValue(
      await runSubprocess(
        [join(dir, "no-such-bin")],
        join(dir, "main.js"),
        dir,
        null,
        5,
        Date.now(),
      ),
    );
    expect(value.exit_code).toBe(-1);
    expect(value.stderr.length).toBeGreaterThan(0);
  }, 30_000);
});
