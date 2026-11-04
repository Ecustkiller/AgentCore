/**
 * 远程 Streamable HTTP MCP —— opt-in 实验运输（生成 / 最后修订 2026-11-04）。
 *
 * 上游《工具与能力系统》§四C 的定案是「运输**仅 stdio**」，并把
 * 「远程 SSE·HTTP MCP」列为「另项」、把「远程 MCP 运输（§四C 二期）」写进
 * 「待定」。也就是**没有否决，但当前版本明确不做**。本 fork 按实验功能落地：
 *
 * - 默认关（实例级 env `MCP_REMOTE_HTTP_ENABLED=true` 才开）时，stdio 路径与
 *   上游逐字节等价：远程配置不能写入、不能启用、不能连接，也不会出现在
 *   `list_tools` 的服务端回填里。
 * - 不做 AgentCore 对外 MCP Server，不做按文件夹 / Agent 绑定，不改 builtin。
 * - 服务端 wire 不变：`mcp_op_required` → `{servers:[…]}` / `call_tool` 的
 *   `server_id` / `tool_name` / `arguments` 都不知道运输层是什么。
 *
 * 安全边界：只收 HTTPS URL、拒绝 URL 内嵌凭据与 fragment、静态请求头白名单、
 * 拒绝跨源重定向。不做 OAuth / 浏览器登录 / 动态 token 刷新，凭据若写进
 * headers 会与既有 `env` 一样明文落在 `mcp-servers.json`（本机 userData）。
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** 实例级开关。只有字面 `true` 才算开，避免 "1" / "yes" 被误读。 */
export const REMOTE_MCP_ENV_FLAG = "MCP_REMOTE_HTTP_ENABLED";

export const REMOTE_MCP_DISABLED_HINT =
  "远程 HTTP MCP 是实验功能，默认关闭；需在启动桌面时设置 MCP_REMOTE_HTTP_ENABLED=true 后重启";

/** 如实声明能力边界，供接线方/文档核对，别把未做的写成已做。 */
export const REMOTE_MCP_CAPABILITIES = {
  enabled_by_default: false,
  config_scope: "instance-level env MCP_REMOTE_HTTP_ENABLED=true",
  upstream_status: "§四C 定案仅 stdio；远程 MCP 运输列为二期 / 待定（非否决）",
  transport: "Streamable HTTP only (not legacy SSE)",
  url_scheme: "https only",
  auth: "static headers only; no OAuth, no browser login, no token refresh",
  redirect: "cross-origin redirects rejected",
  stdio_path_unchanged_when_off: true,
  server_wire_unchanged: true,
  folder_or_agent_binding: false,
  agentcore_as_mcp_server: false,
} as const;

const MAX_URL_LENGTH = 2048;
const MAX_HEADER_COUNT = 20;
const MAX_HEADER_VALUE_LENGTH = 4096;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** C0 控制符 + DEL。用码点判定，避免正则里写控制字符区间触发 lint。 */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * 禁止由配置注入的 hop-by-hop / 协议级请求头。这些字段要么由 undici 自己管，
 * 要么会改变帧语义；放行它们等于让用户配置改写运输层行为。
 */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
]);

export function remoteMcpEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REMOTE_MCP_ENV_FLAG] === "true";
}

export type RemoteUrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * URL fail closed：只认 https，不认 http / file / ws / 自定义 scheme。
 * 明文 http 会把静态请求头（可能含 token）送到链路上，v1 一律拒。
 */
export function validateRemoteUrl(raw: unknown): RemoteUrlVerdict {
  if (typeof raw !== "string") {
    return { ok: false, reason: "URL 必须是字符串" };
  }
  const text = raw.trim();
  if (!text) return { ok: false, reason: "URL 不能为空" };
  if (text.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL 超过 ${MAX_URL_LENGTH} 字符` };
  }
  if (hasControlChars(text) || /\s/.test(text) || text.includes("\\")) {
    return { ok: false, reason: "URL 不得含空白、控制字符或反斜杠" };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "URL 无法解析" };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: "只允许 https://（明文 http 与本地回环一律拒绝）",
    };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URL 不得内嵌用户名/密码，请改用请求头" };
  }
  if (url.hash) {
    return { ok: false, reason: "URL 不得带 fragment" };
  }
  if (!url.hostname) {
    return { ok: false, reason: "URL 缺少主机名" };
  }
  return { ok: true, url };
}

export type RemoteHeadersVerdict =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: string };

export function validateRemoteHeaders(input: unknown): RemoteHeadersVerdict {
  if (input === undefined || input === null) {
    return { ok: true, headers: {} };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "请求头必须是键值对象" };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_HEADER_COUNT) {
    return { ok: false, reason: `请求头最多 ${MAX_HEADER_COUNT} 项` };
  }
  const headers: Record<string, string> = {};
  for (const [name, rawValue] of entries) {
    if (!HEADER_NAME_RE.test(name)) {
      return { ok: false, reason: `非法请求头名：${name}` };
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      return { ok: false, reason: `请求头 ${name} 由运输层管理，不能配置` };
    }
    if (typeof rawValue !== "string") {
      return { ok: false, reason: `请求头 ${name} 的值必须是字符串` };
    }
    if (rawValue.length > MAX_HEADER_VALUE_LENGTH) {
      return { ok: false, reason: `请求头 ${name} 的值过长` };
    }
    if (hasControlChars(rawValue)) {
      return { ok: false, reason: `请求头 ${name} 的值含控制字符` };
    }
    headers[name] = rawValue;
  }
  return { ok: true, headers };
}

/** origin 含 scheme + host + port，用来卡死重定向与 SDK 内部换 URL。 */
export function sameMcpOrigin(
  left: string | URL,
  right: string | URL,
): boolean {
  try {
    return new URL(left.toString()).origin === new URL(right.toString()).origin;
  } catch {
    return false;
  }
}

/**
 * 给 SDK 的 fetch 套一层：每次请求都重新验 URL，并拒绝跨源重定向。
 * 只做校验与转发，不改 init（SDK 自己管 method / headers / signal）。
 */
export function createGuardedFetch(
  original: string | URL,
  baseFetch: FetchLike = (url, init) => fetch(url, init),
): FetchLike {
  const base = new URL(original.toString());
  return async (url, init) => {
    const verdict = validateRemoteUrl(url.toString());
    if (!verdict.ok) {
      throw new Error(`远程 MCP 请求 URL 校验失败：${verdict.reason}`);
    }
    if (!sameMcpOrigin(verdict.url, base)) {
      throw new Error("远程 MCP 请求不得离开配置里的源");
    }
    const response = await baseFetch(url, init);
    // undici 的 Response.url 是跟随重定向后的最终地址；manual redirect 时为原地址。
    if (response.url && !sameMcpOrigin(response.url, base)) {
      throw new Error("远程 MCP 不允许跨源重定向");
    }
    return response;
  };
}
