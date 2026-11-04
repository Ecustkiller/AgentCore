import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * 本机 MCP Client（最后修订 2026-11-04）—— 主进程经官方 SDK 拉起 stdio Server；
 * 另有 opt-in、默认关的 Streamable HTTP 运输（`mcp-remote.ts`，上游 §四C 二期）。
 *
 * 运输层对标 Host：renderer 收到 `mcp_op_required` 后经本 IPC 执行，再
 * resolveInteraction 回填；不经云端假连 127.0.0.1。
 *
 * stderr 以 pipe 采集并纳入握手/调用失败明细（勿整段 ignore）；只 stdio 有
 * stderr，HTTP 运输下失败明细就是 SDK 的错误本身。
 *
 * 契约：服务端 `parse_mcp_list_payload()` 只认 `{servers:[{id,name,status,tools}]}`，
 * `call_tool` 只认 `server_id`/`tool_name`/`arguments`，所以运输层对服务端透明。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  MCP_CHANNELS,
  type McpConfigResult,
  type McpMutationResult,
  type McpOpInput,
  type McpOpResult,
  type McpServerConfig,
  type McpServerListItem,
  type McpTestResult,
  type McpTransportKind,
} from "@shared/mcp-contract";
import { app, ipcMain } from "electron";
import {
  REMOTE_MCP_DISABLED_HINT,
  createGuardedFetch,
  remoteMcpEnabled,
  validateRemoteHeaders,
  validateRemoteUrl,
} from "./mcp-remote";

const RPC_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 45_000;
const STDERR_TAIL_MAX = 4_000;

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface LiveSession {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  tools: McpToolInfo[];
  ready: boolean;
  lastError?: string;
  stderrChunks: string[];
  stderrBytes: number;
}

function transportKind(config: McpServerConfig): McpTransportKind {
  return config.transport === "http" ? "http" : "stdio";
}

function configPath(): string {
  return join(app.getPath("userData"), "mcp-servers.json");
}

function ensureConfigFile(): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify({ servers: [] }, null, 2), "utf8");
  }
}

function normalizeConfig(s: Record<string, unknown>): McpServerConfig | null {
  const transport: McpTransportKind = s.transport === "http" ? "http" : "stdio";
  const command = String(s.command || "").trim();
  const url = typeof s.url === "string" ? s.url.trim() : "";
  // 半填的配置既不进目录也不连接，避免把「有 id 但连不上」的幽灵 Server 报给模型。
  if (transport === "stdio" && !command) return null;
  if (transport === "http" && !url) return null;
  const env =
    s.env && typeof s.env === "object" && !Array.isArray(s.env)
      ? Object.fromEntries(
          Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [
            k,
            String(v),
          ]),
        )
      : undefined;
  const headers =
    s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)
      ? Object.fromEntries(
          Object.entries(s.headers as Record<string, unknown>).map(([k, v]) => [
            k,
            String(v),
          ]),
        )
      : undefined;
  return {
    id: String(s.id || randomUUID()),
    name: String(s.name || "MCP Server"),
    enabled: s.enabled !== false,
    transport,
    command,
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    env,
    ...(transport === "http" ? { url, headers } : {}),
  };
}

function loadConfigs(): McpServerConfig[] {
  ensureConfigFile();
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as {
      servers?: unknown;
    };
    if (!Array.isArray(raw.servers)) return [];
    return raw.servers
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map(normalizeConfig)
      .filter((s): s is McpServerConfig => s !== null);
  } catch {
    return [];
  }
}

/**
 * 真正允许握手的集合。实验关时 http 条目直接消失（而不是报 failed），
 * 于是服务端 `list_tools` 回填与上游「仅 stdio」逐字节一致。
 */
function usableConfigs(): McpServerConfig[] {
  const all = loadConfigs();
  return remoteMcpEnabled()
    ? all
    : all.filter((s) => transportKind(s) !== "http");
}

function saveConfigs(servers: McpServerConfig[]): void {
  ensureConfigFile();
  writeFileSync(configPath(), JSON.stringify({ servers }, null, 2), "utf8");
}

const sessions = new Map<string, LiveSession>();

function appendStderr(live: LiveSession, chunk: string): void {
  if (!chunk) return;
  live.stderrChunks.push(chunk);
  live.stderrBytes += chunk.length;
  while (live.stderrBytes > STDERR_TAIL_MAX && live.stderrChunks.length > 1) {
    const dropped = live.stderrChunks.shift() || "";
    live.stderrBytes -= dropped.length;
  }
  // Main-process observability — do not swallow MCP server diagnostics.
  console.error(`[mcp:${live.config.name}] ${chunk.trimEnd()}`);
}

function stderrTail(live: LiveSession): string {
  const raw = live.stderrChunks.join("").trim();
  if (!raw) return "";
  return raw.length > STDERR_TAIL_MAX ? raw.slice(-STDERR_TAIL_MAX) : raw;
}

function formatError(live: LiveSession | null, detail: string): string {
  const base = detail.trim() || "MCP 操作失败";
  const tail = live ? stderrTail(live) : "";
  if (!tail) return base;
  return `${base}\n--- MCP stderr ---\n${tail}`;
}

async function killSession(id: string): Promise<void> {
  const live = sessions.get(id);
  if (!live) return;
  sessions.delete(id);
  live.ready = false;
  try {
    await live.client.close();
  } catch {
    /* ignore teardown races */
  }
  try {
    await live.transport.close();
  } catch {
    /* ignore */
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}超时（${ms}ms）`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function spawnEnv(config: McpServerConfig): Record<string, string> {
  // SDK allowlist only — never leak the full parent process.env into MCP children.
  // Server-specific overrides still win.
  return { ...getDefaultEnvironment(), ...(config.env || {}) };
}

async function connectSession(config: McpServerConfig): Promise<LiveSession> {
  const client = new Client({
    name: "agentcore-desktop",
    version: app.getVersion(),
  });
  let transport: Transport;
  let stdio: StdioClientTransport | null = null;

  if (transportKind(config) === "http") {
    // 双重闸：usableConfigs() 已在调用侧挡过一次，这里再挡一次，
    // 防止未来某个入口绕过过滤直接调 connectSession。
    if (!remoteMcpEnabled()) throw new Error(REMOTE_MCP_DISABLED_HINT);
    const urlVerdict = validateRemoteUrl(config.url);
    if (!urlVerdict.ok) {
      throw new Error(`远程 MCP URL 非法：${urlVerdict.reason}`);
    }
    const headerVerdict = validateRemoteHeaders(config.headers);
    if (!headerVerdict.ok) {
      throw new Error(`远程 MCP 请求头非法：${headerVerdict.reason}`);
    }
    transport = new StreamableHTTPClientTransport(urlVerdict.url, {
      requestInit: { headers: headerVerdict.headers },
      fetch: createGuardedFetch(urlVerdict.url),
    });
  } else {
    stdio = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: spawnEnv(config),
      stderr: "pipe",
    });
    transport = stdio;
  }

  const live: LiveSession = {
    config,
    client,
    transport,
    tools: [],
    ready: false,
    stderrChunks: [],
    stderrBytes: 0,
  };

  const stderr = stdio?.stderr;
  if (stderr) {
    // StdioClientTransport.stderr is typed as Stream (no setEncoding).
    // Decode Buffer|string in the data callback — keep stderr observable.
    stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      appendStderr(live, text);
    });
  }

  transport.onerror = (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    live.lastError = formatError(live, detail);
    console.error(`[mcp:${config.name}] transport error:`, detail);
  };
  transport.onclose = () => {
    if (sessions.get(config.id) === live) {
      sessions.delete(config.id);
      live.ready = false;
    }
  };

  try {
    await withTimeout(
      client.connect(transport),
      HANDSHAKE_TIMEOUT_MS,
      `MCP 握手（${config.name}）`,
    );
    const listed = await withTimeout(
      client.listTools(),
      RPC_TIMEOUT_MS,
      `MCP tools/list（${config.name}）`,
    );
    const tools: McpToolInfo[] = [];
    for (const t of listed.tools ?? []) {
      const name = String(t.name || "").trim();
      if (!name) continue;
      tools.push({
        name,
        description:
          typeof t.description === "string" ? t.description : undefined,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : undefined,
      });
    }
    live.tools = tools;
    live.ready = true;
    return live;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    live.lastError = formatError(live, detail);
    live.ready = false;
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    throw new Error(live.lastError);
  }
}

async function ensureReady(config: McpServerConfig): Promise<LiveSession> {
  const existing = sessions.get(config.id);
  if (existing?.ready) {
    return existing;
  }
  if (existing) await killSession(config.id);
  const live = await connectSession(config);
  sessions.set(config.id, live);
  return live;
}

export async function listMcpToolsValue(): Promise<Record<string, unknown>> {
  return listToolsValue();
}

async function listToolsValue(): Promise<Record<string, unknown>> {
  const configs = usableConfigs().filter((s) => s.enabled);
  const servers: Array<Record<string, unknown>> = [];
  for (const cfg of configs) {
    try {
      const live = await ensureReady(cfg);
      servers.push({
        id: cfg.id,
        name: cfg.name,
        status: "ready",
        tools: live.tools,
      });
    } catch (e) {
      servers.push({
        id: cfg.id,
        name: cfg.name,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        tools: [],
      });
    }
  }
  return { servers };
}

async function callToolValue(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const serverId = String(args.server_id || "").trim();
  const toolName = String(args.tool_name || "").trim();
  const toolArgs =
    args.arguments && typeof args.arguments === "object"
      ? (args.arguments as Record<string, unknown>)
      : {};
  if (!serverId || !toolName) {
    throw new Error("call_tool 需要 server_id 与 tool_name");
  }
  const cfg = usableConfigs().find((s) => s.id === serverId && s.enabled);
  if (!cfg) {
    const gated = loadConfigs().some(
      (s) => s.id === serverId && transportKind(s) === "http",
    );
    throw new Error(
      gated
        ? REMOTE_MCP_DISABLED_HINT
        : `MCP Server 未启用或不存在（${serverId}）`,
    );
  }
  const live = await ensureReady(cfg);
  try {
    const result = await withTimeout(
      live.client.callTool({ name: toolName, arguments: toolArgs }),
      RPC_TIMEOUT_MS,
      `MCP tools/call（${toolName}）`,
    );
    return (result || {}) as Record<string, unknown>;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    live.lastError = formatError(live, detail);
    throw new Error(live.lastError);
  }
}

async function runOp(input: McpOpInput): Promise<McpOpResult> {
  try {
    const op = String(input.op || "");
    const args = (input.args || {}) as Record<string, unknown>;
    if (op === "list_tools") {
      return { ok: true, value: await listToolsValue() };
    }
    if (op === "call_tool") {
      return { ok: true, value: await callToolValue(args) };
    }
    return {
      ok: false,
      error: { kind: "McpOpError", detail: `未知 MCP op：${op}` },
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "McpOpError",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

function toListItem(cfg: McpServerConfig): McpServerListItem {
  const live = sessions.get(cfg.id);
  // 配置仍可见（不静默吞用户数据），但实验关时明确标注不可用原因。
  const gated = transportKind(cfg) === "http" && !remoteMcpEnabled();
  return {
    ...cfg,
    runtimeStatus: gated
      ? "failed"
      : live?.ready
        ? "ready"
        : live?.lastError
          ? "failed"
          : "idle",
    runtimeError: gated ? REMOTE_MCP_DISABLED_HINT : live?.lastError,
  };
}

function listServers(): McpConfigResult {
  try {
    return { ok: true, servers: loadConfigs().map(toListItem) };
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "McpConfigError",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

function upsertServer(server: McpServerConfig): McpMutationResult {
  try {
    const transport: McpTransportKind =
      server.transport === "http" ? "http" : "stdio";
    // 默认关时不写入任何远程配置，实验面从根上保持空。
    if (transport === "http" && !remoteMcpEnabled()) {
      return {
        ok: false,
        error: { kind: "McpConfigError", detail: REMOTE_MCP_DISABLED_HINT },
      };
    }
    if (transport === "stdio" && !server.command?.trim()) {
      return {
        ok: false,
        error: { kind: "McpConfigError", detail: "command 不能为空" },
      };
    }
    const urlVerdict =
      transport === "http" ? validateRemoteUrl(server.url) : null;
    if (urlVerdict && !urlVerdict.ok) {
      return {
        ok: false,
        error: {
          kind: "McpConfigError",
          detail: `远程 MCP URL 非法：${urlVerdict.reason}`,
        },
      };
    }
    const headerVerdict =
      transport === "http" ? validateRemoteHeaders(server.headers) : null;
    if (headerVerdict && !headerVerdict.ok) {
      return {
        ok: false,
        error: {
          kind: "McpConfigError",
          detail: `远程 MCP 请求头非法：${headerVerdict.reason}`,
        },
      };
    }

    const id = server.id?.trim() || randomUUID();
    const next: McpServerConfig = {
      id,
      name: (server.name || "MCP Server").trim() || "MCP Server",
      enabled: server.enabled !== false,
      transport,
      command: transport === "stdio" ? server.command.trim() : "",
      args:
        transport === "stdio" && Array.isArray(server.args)
          ? server.args.map(String)
          : [],
      env: transport === "stdio" ? server.env : undefined,
      ...(transport === "http"
        ? {
            url: urlVerdict?.ok ? urlVerdict.url.toString() : "",
            headers: headerVerdict?.ok ? headerVerdict.headers : {},
          }
        : {}),
    };
    const all = loadConfigs();
    const idx = all.findIndex((s) => s.id === id);
    if (idx >= 0) {
      all[idx] = next;
      void killSession(id);
    } else {
      all.push(next);
    }
    saveConfigs(all);
    return { ok: true, server: toListItem(next) };
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "McpConfigError",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

function removeServer(id: string): McpConfigResult {
  try {
    void killSession(id);
    const all = loadConfigs().filter((s) => s.id !== id);
    saveConfigs(all);
    return { ok: true, servers: all.map(toListItem) };
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "McpConfigError",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

function setServerEnabled(id: string, enabled: boolean): McpMutationResult {
  const all = loadConfigs();
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) {
    return {
      ok: false,
      error: { kind: "McpConfigError", detail: "Server 不存在" },
    };
  }
  // 关时允许把远程条目禁用掉（用户能收拾现场），但不能把它启用。
  if (enabled && transportKind(all[idx]) === "http" && !remoteMcpEnabled()) {
    return {
      ok: false,
      error: { kind: "McpConfigError", detail: REMOTE_MCP_DISABLED_HINT },
    };
  }
  all[idx] = { ...all[idx], enabled };
  if (!enabled) void killSession(id);
  saveConfigs(all);
  return { ok: true, server: toListItem(all[idx]) };
}

async function testServer(id: string): Promise<McpTestResult> {
  const cfg = loadConfigs().find((s) => s.id === id);
  if (!cfg) {
    return {
      ok: false,
      error: { kind: "McpConfigError", detail: "Server 不存在" },
    };
  }
  if (transportKind(cfg) === "http" && !remoteMcpEnabled()) {
    return {
      ok: false,
      error: { kind: "McpConfigError", detail: REMOTE_MCP_DISABLED_HINT },
    };
  }
  try {
    await killSession(id);
    const live = await ensureReady(cfg);
    return { ok: true, status: "ready", tools: live.tools };
  } catch (e) {
    return {
      ok: true,
      status: "failed",
      tools: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function registerMcpIpc(): void {
  ipcMain.handle(MCP_CHANNELS.runOp, async (_e, input: McpOpInput) =>
    runOp(input),
  );
  ipcMain.handle(MCP_CHANNELS.listServers, async () => listServers());
  ipcMain.handle(
    MCP_CHANNELS.upsertServer,
    async (_e, server: McpServerConfig) => upsertServer(server),
  );
  ipcMain.handle(MCP_CHANNELS.removeServer, async (_e, id: string) =>
    removeServer(id),
  );
  ipcMain.handle(
    MCP_CHANNELS.setServerEnabled,
    async (_e, id: string, enabled: boolean) => setServerEnabled(id, enabled),
  );
  ipcMain.handle(MCP_CHANNELS.testServer, async (_e, id: string) =>
    testServer(id),
  );
}

export async function shutdownAllMcpSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => killSession(id)));
}
