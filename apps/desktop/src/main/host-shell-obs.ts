/**
 * host_shell 环境隔离 + 观测。
 *
 * 动机：AgentCore DEV 经 host_shell 拉起其它 Electron 应用时，若透传 `process.env`
 * （含 ELECTRON_RENDERER_URL 等），子进程会被污染成「壳是目标 App、馅是本产品」。
 * 策略：在保留 PATH / 用户配置等通用变量的前提下，剥掉 Electron / electron-vite /
 * 本包脚本身份相关 key；并留下指纹与窗口快照便于对照。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 须从 host_shell 子进程 env 剥掉的 key（denylist）。
 * 不走「白名单极简 env」——用户命令仍需要 APPDATA / PATH 等正常系统变量。
 */
const SHELL_ENV_STRIP_PATTERNS: RegExp[] = [
  /^ELECTRON_/i,
  /^NODE_ENV_ELECTRON/i,
  /^VITE_/i,
  /^CHROME_CRASHPAD_/i,
  /^npm_package_/i,
  /^npm_lifecycle_/i,
  /^npm_config_electron/i,
  /^PNPM_SCRIPT_SRC_DIR$/i,
  /^INIT_CWD$/i,
  /^NODE_PATH$/i,
];

/** 指纹扫描：与污染相关的 key（含 NODE_ENV，便于看见 development 透传；不剥 NODE_ENV）。 */
const ENV_FINGERPRINT_PATTERNS: RegExp[] = [
  ...SHELL_ENV_STRIP_PATTERNS,
  /^NODE_ENV$/i,
];

/** 允许记入指纹的非密钥 value（便于对照「是否指向本仓库 vite」）。 */
const SAFE_VALUE_KEYS = new Set([
  "ELECTRON_RENDERER_URL",
  "ELECTRON_EXEC_PATH",
  "ELECTRON_MAJOR_VER",
  "NODE_ENV_ELECTRON_VITE",
  "NODE_ENV",
  "npm_package_name",
  "npm_lifecycle_script",
  "INIT_CWD",
]);

export type ShellEnvFingerprint = {
  matching_keys: string[];
  safe_values: Record<string, string>;
  electron_renderer_url_set: boolean;
  electron_exec_path_set: boolean;
};

export type ShellWindowSnap = {
  pid: number;
  process: string;
  title: string;
  path: string;
};

/** 启发式：命令像在拉 GUI 应用时才做窗口快照（避免每次 echo 都多跑一次枚举）。 */
export function looksLikeGuiLaunch(command: string): boolean {
  return /Start-Process|Invoke-Item|\.exe\b|open\s+-a\b|xdg-open\b/i.test(
    command,
  );
}

function keyMatches(patterns: RegExp[], key: string): boolean {
  return patterns.some((re) => re.test(key));
}

export function shouldStripShellEnvKey(key: string): boolean {
  return keyMatches(SHELL_ENV_STRIP_PATTERNS, key);
}

/**
 * 构造 host_shell 子进程环境：复制 parent，剥掉 Electron/vite/脚本身份 key。
 * 不修改传入对象。
 */
export function buildHostShellEnv(parent: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv;
  stripped_keys: string[];
} {
  const env: NodeJS.ProcessEnv = {};
  const stripped_keys: string[] = [];
  for (const key of Object.keys(parent)) {
    const value = parent[key];
    if (value === undefined) continue;
    if (shouldStripShellEnvKey(key)) {
      stripped_keys.push(key);
      continue;
    }
    env[key] = value;
  }
  stripped_keys.sort();
  return { env, stripped_keys };
}

export function fingerprintShellEnv(
  env: NodeJS.ProcessEnv = process.env,
): ShellEnvFingerprint {
  const matching_keys: string[] = [];
  const safe_values: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (!keyMatches(ENV_FINGERPRINT_PATTERNS, key)) continue;
    matching_keys.push(key);
    if (SAFE_VALUE_KEYS.has(key)) {
      const raw = env[key];
      if (typeof raw === "string" && raw.length > 0) {
        safe_values[key] = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
      }
    }
  }
  return {
    matching_keys,
    safe_values,
    electron_renderer_url_set: Boolean(env.ELECTRON_RENDERER_URL),
    electron_exec_path_set: Boolean(env.ELECTRON_EXEC_PATH),
  };
}

/**
 * 枚举带主窗标题的进程（best-effort）。失败返回 []，不抛。
 * Windows：PowerShell Get-Process；其它平台暂空（观测期 Win 优先）。
 */
export async function snapshotVisibleMainWindows(
  limit = 24,
): Promise<ShellWindowSnap[]> {
  if (process.platform !== "win32") return [];
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |",
    `  Select-Object -First ${String(Math.max(1, Math.min(limit, 40)))} Id,ProcessName,MainWindowTitle,Path |`,
    "  ForEach-Object {",
    "    [pscustomobject]@{ pid=$_.Id; process=$_.ProcessName; title=$_.MainWindowTitle; path=($_.Path ?? '') }",
    "  } | ConvertTo-Json -Compress",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 4000, windowsHide: true, encoding: "utf8" },
    );
    const text = String(stdout || "").trim();
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? [parsed]
        : [];
    const out: ShellWindowSnap[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const pid = Number(r.pid);
      if (!Number.isFinite(pid)) continue;
      out.push({
        pid,
        process: String(r.process ?? ""),
        title: String(r.title ?? ""),
        path: String(r.path ?? ""),
      });
    }
    return out;
  } catch {
    return [];
  }
}
