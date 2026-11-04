/**
 * 本机 MCP Client IPC 契约 —— 主进程 / preload / renderer 三端共享（最后修订 2026-11-04）。
 *
 * 服务端经 `mcp_op_required` ClientTool 回填；桌面主进程拉起 stdio MCP Server，
 * 禁止云 API 进程直连本机。
 *
 * 上游 §四C 定案「运输仅 stdio」；`transport: "http"` 是本 fork 的 opt-in
 * 实验（§四C 二期方向），默认关且默认态与上游等价。服务端 wire 完全不知道
 * 运输层，见 `main/mcp-remote.ts`。
 */

export const MCP_CHANNELS = {
  runOp: "mcp:runOp",
  listServers: "mcp:listServers",
  upsertServer: "mcp:upsertServer",
  removeServer: "mcp:removeServer",
  setServerEnabled: "mcp:setServerEnabled",
  testServer: "mcp:testServer",
} as const;

export type McpOpName = "list_tools" | "call_tool";

export interface McpOpInput {
  op: McpOpName | string;
  args?: Record<string, unknown>;
}

export type McpOpResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { kind: string; detail: string } };

/** `stdio` 是上游定案，缺字段时一律按 stdio 读（兼容既有 mcp-servers.json）。 */
export type McpTransportKind = "stdio" | "http";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport?: McpTransportKind;
  /** stdio 必填；http 配置为空串。 */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** 仅 http：Streamable HTTP 端点，主进程只收 https。 */
  url?: string;
  /** 仅 http：静态请求头。不做 OAuth，值明文落在本机 userData 配置里。 */
  headers?: Record<string, string>;
}

export interface McpServerListItem extends McpServerConfig {
  /** Last known handshake status (best-effort, not durable). */
  runtimeStatus?: "idle" | "ready" | "failed";
  runtimeError?: string;
}

export type McpConfigResult =
  | { ok: true; servers: McpServerListItem[] }
  | { ok: false; error: { kind: string; detail: string } };

export type McpMutationResult =
  | { ok: true; server: McpServerListItem }
  | { ok: false; error: { kind: string; detail: string } };

export type McpTestResult =
  | {
      ok: true;
      status: "ready" | "failed";
      tools: Array<{ name: string; description?: string }>;
      error?: string;
    }
  | { ok: false; error: { kind: string; detail: string } };

export interface McpApi {
  runOp: (input: McpOpInput) => Promise<McpOpResult>;
  listServers: () => Promise<McpConfigResult>;
  upsertServer: (server: McpServerConfig) => Promise<McpMutationResult>;
  removeServer: (id: string) => Promise<McpConfigResult>;
  setServerEnabled: (
    id: string,
    enabled: boolean,
  ) => Promise<McpMutationResult>;
  testServer: (id: string) => Promise<McpTestResult>;
}
