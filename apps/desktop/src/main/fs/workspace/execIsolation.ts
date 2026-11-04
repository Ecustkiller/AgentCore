/**
 * 桌面本地代码执行的隔离策略（生成 2026-11-04 / 最后修订 2026-11-04）。
 *
 * 背景：本地 `code_execute` 跑在用户自己机器上，父进程是 Electron 主进程。历史上
 * `spawn(..., { env: undefined })` 直接继承完整 `process.env`——宿主里的
 * `LD_PRELOAD` / `DYLD_*` / `NODE_OPTIONS` / `BASH_ENV` 会被解释器或 shell
 * **自动加载执行**。API 侧的 `pickUserExecEnv` 只挡住了请求体注入，挡不住这条
 * 「继承」路径。gVisor / sandboxd 那套隔离只服务云端 `location="server"`，桌面
 * local 完全不经过，所以这里必须自己收口。
 *
 * 分三层，默认行为不变：
 *  1. **默认开（零行为变化）**：剥掉宿主继承里的高危「自动执行/动态链接」键。
 *     正常脚本不依赖这些键；`PYTHONPATH` 刻意保留，因为 D11′ 契约要求
 *     `buildWorkspacePythonpathEnv` 合并宿主值。
 *  2. **opt-in 严格 env 白名单**：`AGENTCORE_LOCAL_EXEC_ENV_STRICT=1`。
 *     只留运行时必需键 + 显式注入的 `envExtra`，丢掉宿主凭据/代理/自定义变量。
 *  3. **opt-in macOS seatbelt**：`AGENTCORE_LOCAL_EXEC_SANDBOX=seatbelt`。
 *     禁网 + 写白名单（工作区 / 脚本临时目录 / 系统临时目录 / /dev）。
 *     开关要求隔离但平台不支持时 **fail closed**，绝不静默退化成裸 spawn。
 *
 * 诚实边界：seatbelt 只做网络与文件写隔离，**不限制 CPU / 内存**。
 * `memory_limit_mb` 在桌面本地执行里仍被忽略，不得对外宣称有 512MB 上限。
 *
 * SBPL 语义已实测（macOS）：`(allow default)` + 条件 deny 的写白名单可做到
 * 白名单内 WRITE-OK、白名单外 EPERM；`(deny network*)` 连 DNS 一起断
 * （curl rc=6 `Could not resolve host`）。用 `require-not` 的条件 deny 而不是
 * 「先 deny 再补 allow 例外」，避免依赖 SBPL 的规则优先级。
 */
import { existsSync } from "node:fs";

/**
 * 宿主 env 里会被子进程自动执行/加载的键（大小写不敏感）。
 * `LD_*` / `DYLD_*` / `BASH_FUNC_*` 走前缀判断，覆盖未列出的变体。
 */
export const HOST_ENV_HIJACK_KEYS: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "NODE_DEBUG",
  "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONEXECUTABLE",
  "PYTHONINSPECT",
  "BASH_ENV",
  "BASHOPTS",
  "SHELLOPTS",
  "ENV",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "PS4",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "DOTNET_STARTUP_HOOKS",
]);

/** 严格模式下运行时必需的键；`LC_*` 与 `envExtra` 另行放行。 */
const STRICT_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "COMSPEC",
  "WINDIR",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "LANG",
  "TERM",
  "TZ",
  "OS",
  // D11′: 宿主 PYTHONPATH 必须能进 python 子进程（buildWorkspacePythonpathEnv 会合并）。
  "PYTHONPATH",
  // TLS 根证书：pip / npm / node 出网（非沙箱模式）都要用。
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

export interface LocalExecIsolation {
  strictEnv: boolean;
  seatbelt: boolean;
}

/** 只认字面值：未知/拼错的值保持关闭，fail closed。 */
export function readLocalExecIsolation(
  env: NodeJS.ProcessEnv = process.env,
): LocalExecIsolation {
  return {
    strictEnv: env.AGENTCORE_LOCAL_EXEC_ENV_STRICT === "1",
    seatbelt: env.AGENTCORE_LOCAL_EXEC_SANDBOX === "seatbelt",
  };
}

function isHostHijackKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper.startsWith("LD_") || upper.startsWith("DYLD_")) return true;
  if (upper.startsWith("BASH_FUNC_")) return true;
  return HOST_ENV_HIJACK_KEYS.has(upper);
}

function isStrictKeyAllowed(key: string): boolean {
  const upper = key.toUpperCase();
  return STRICT_ENV_KEYS.has(upper) || upper.startsWith("LC_");
}

/**
 * 构造子进程 env。永远显式传 `env`，不再依赖 `spawn` 的隐式继承。
 *
 * `envExtra` 是已经过白名单/拒绝表筛选的显式注入（外部根、registry 覆盖、
 * PYTHONPATH、临时用户键），优先级最高，且不受严格模式裁剪。
 */
export function buildChildEnv(
  envExtra?: Record<string, string>,
  host: NodeJS.ProcessEnv = process.env,
  isolation: LocalExecIsolation = readLocalExecIsolation(host),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined) continue;
    if (isHostHijackKey(key)) continue;
    if (isolation.strictEnv && !isStrictKeyAllowed(key)) continue;
    out[key] = value;
  }
  if (envExtra) Object.assign(out, envExtra);
  return out;
}

export const SEATBELT_BIN = "/usr/bin/sandbox-exec";

/** `sandbox-exec` 在 macOS 上是系统自带但已 deprecated，运行前必须探活。 */
export function seatbeltAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SEATBELT_BIN);
}

/**
 * 开关要求隔离但平台做不到时返回拒绝文案，调用方据此**拒绝执行**。
 * 绝不静默降级成裸 spawn——「以为有沙箱」比「没有沙箱」更危险。
 * `available` 可注入，便于在非 macOS 上验证 fail closed。
 */
export function seatbeltRefusalReason(
  isolation: LocalExecIsolation,
  available: boolean = seatbeltAvailable(),
): string | null {
  if (!isolation.seatbelt || available) return null;
  return "Sandbox unavailable: AGENTCORE_LOCAL_EXEC_SANDBOX=seatbelt requires macOS /usr/bin/sandbox-exec; refusing to run unisolated.";
}

function sbplQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 生成 SBPL profile。`writableRoots` 必须传**真实路径**（macOS 上 `/tmp`、
 * `/var` 都是符号链接，用别名做 `subpath` 匹配会失效）。
 */
export function buildSeatbeltProfile(writableRoots: readonly string[]): string {
  const roots = [...new Set(writableRoots.filter(Boolean))];
  const paths = [
    ...roots.map((p) => `      (subpath ${sbplQuote(p)})`),
    '      (subpath "/dev")',
  ].join("\n");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*",
    "  (require-not",
    "    (require-any",
    paths,
    "    )))",
    "",
  ].join("\n");
}

/** 包装执行命令前缀；`runSubprocess` 会把 scriptFile 追加到这个数组末尾。 */
export function seatbeltArgv(
  cmd: readonly string[],
  profilePath: string,
): string[] {
  return [SEATBELT_BIN, "-f", profilePath, "--", ...cmd];
}

/** 对外能力声明：不落实的限制一律如实标 false，避免「宣称了但没做」。 */
export const LOCAL_EXEC_CAPABILITIES = {
  memoryLimitEnforced: false,
  cpuLimitEnforced: false,
  processTreeKill: true,
  envHijackKeysStripped: true,
  strictEnvOptIn: "AGENTCORE_LOCAL_EXEC_ENV_STRICT=1",
  seatbeltOptIn: "AGENTCORE_LOCAL_EXEC_SANDBOX=seatbelt",
} as const;
