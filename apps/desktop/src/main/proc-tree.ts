/**
 * 杀掉子进程**整棵树**——桌面侧对齐服务端 `git_ops.spawn._reap_git_process`。
 *
 * `child.kill()` 只作用于直接子进程（Windows 是 TerminateProcess，POSIX 是不升级的
 * SIGTERM）。它派生的孙进程（`git-remote-https`、credential helper、hook…）会变成
 * 孤儿继续跑，仍持有 `.git/index.lock`，于是下一次调用接着超时。本机跑 AI 脚本
 * （`code_execute` / `test_run`）与后台进程同理：孤儿留在用户机器上占端口占 CPU。
 *
 * 用法：spawn 时带上 `treeSpawnOptions()`，杀时用 `killProcessTree()`——POSIX 靠新
 * 会话把整个进程组一次性 SIGKILL，Windows 靠 `taskkill /T` 自己走父子树。
 * 退出钩子等「事件循环不会再转」的场合改用 `killProcessTreeSync()`。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

/** `taskkill` 自身的墙钟。 */
const TASKKILL_TIMEOUT_MS = 4_000;

/** POSIX 新建会话，使超时路径能 `kill(-pid)` 整组；Windows 无需（走 taskkill /T）。 */
export function treeSpawnOptions(): { detached?: boolean } {
  return process.platform === "win32" ? {} : { detached: true };
}

function stillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * 可下手的 pid，否则 `null`。
 *
 * 只在进程还活着时返回 pid：已退出的 pid 可能已被系统回收给别人，收尸不能误伤。
 */
function killablePid(child: ChildProcess): number | null {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) return null;
  return stillRunning(child) ? pid : null;
}

function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
        // spawn 自带的墙钟：收尸不能比被收的进程还难杀。
        timeout: TASKKILL_TIMEOUT_MS,
      });
    } catch {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

function killPosixTree(child: ChildProcess, pid: number): void {
  try {
    // 负 pid = 整个进程组；仅因 `treeSpawnOptions()` 让它成为会话/组长才成立。
    process.kill(-pid, "SIGKILL");
  } catch {
    /* 组已消失，或它不是组长 */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* 已被回收 */
  }
}

/**
 * 尽力而为、有界、永不抛。resolve 表示「杀已发出」（Windows 是 taskkill 退出或撞到
 * 自己的墙钟），调用方自行决定还要等多久 pipe 关闭。
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = killablePid(child);
  if (pid === null) return;
  if (process.platform !== "win32") {
    killPosixTree(child, pid);
    return;
  }
  await killWindowsTree(pid);
  finalBlow(child);
}

/**
 * 同步变体——只给「事件循环不会再转」的场合：`app.on("before-quit")` 里发出异步
 * kill，进程可能在 taskkill 起来之前就退了，留下满地孤儿。
 *
 * 代价是 Windows 上 `spawnSync` 会阻塞主进程（最长 {@link TASKKILL_TIMEOUT_MS}），
 * 退出路径可以接受，**常规路径一律用 {@link killProcessTree}**。POSIX 两者等价：
 * `killpg` 本身就是同步系统调用。
 */
export function killProcessTreeSync(child: ChildProcess): void {
  const pid = killablePid(child);
  if (pid === null) return;
  if (process.platform !== "win32") {
    killPosixTree(child, pid);
    return;
  }
  try {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
    });
  } catch {
    /* taskkill 不存在或被策略拦下 */
  }
  finalBlow(child);
}

/** taskkill 没够着（进程受保护 / 超时）时，至少把直接子进程解决掉。 */
function finalBlow(child: ChildProcess): void {
  if (!stillRunning(child)) return;
  try {
    child.kill();
  } catch {
    /* 已消失 */
  }
}
