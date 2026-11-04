/**
 * Unit tests for MCP config helpers / SDK wiring (no real child process).
 * 生成 / 最后修订 2026-11-04：补 opt-in 远程 HTTP 运输的默认关与 fail closed。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn();
const listTools = vi.fn();
const callTool = vi.fn();
const clientClose = vi.fn();
const transportClose = vi.fn();
const getDefaultEnvironment = vi.fn(() => ({
  PATH: "/safe/bin",
  HOME: "/home/test",
}));
const onDataHandlers: Array<(chunk: Buffer | string) => void> = [];
const transportCtorArgs: Array<{
  command?: string;
  env?: Record<string, string>;
}> = [];

const { fixture, httpCtorArgs } = vi.hoisted(() => ({
  fixture: { servers: [] as unknown[] },
  httpCtorArgs: [] as Array<{
    url: URL;
    opts: {
      requestInit?: { headers?: Record<string, string> };
      fetch?: unknown;
    };
  }>,
}));

const STDIO_SERVER = {
  id: "srv1",
  name: "Echo",
  enabled: true,
  command: "npx",
  args: ["-y", "fake-mcp"],
  env: { MCP_TOKEN: "from-config" },
};

const HTTP_SERVER = {
  id: "remote1",
  name: "Remote",
  enabled: true,
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: "Bearer test-token" },
};

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/agentcore-mcp-test",
    getVersion: () => "0.0.0-test",
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connect;
    listTools = listTools;
    callTool = callTool;
    close = clientClose;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => getDefaultEnvironment(),
  StdioClientTransport: class {
    onerror?: (error: Error) => void;
    onclose?: () => void;
    stderr = {
      on: vi.fn((event: string, cb: (chunk: Buffer | string) => void) => {
        if (event === "data") onDataHandlers.push(cb);
      }),
    };
    close = transportClose;
    constructor(params: { command?: string; env?: Record<string, string> }) {
      transportCtorArgs.push(params);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    onerror?: (error: Error) => void;
    onclose?: () => void;
    close = transportClose;
    constructor(
      url: URL,
      opts: {
        requestInit?: { headers?: Record<string, string> };
        fetch?: unknown;
      },
    ) {
      httpCtorArgs.push({ url, opts });
    }
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify(fixture)),
    writeFileSync: vi.fn(),
  };
});

type IpcHandler = (...args: unknown[]) => Promise<unknown> | unknown;

interface ListToolsValue {
  servers?: Array<{
    id?: string;
    error?: string;
    status?: string;
    tools?: unknown[];
  }>;
}

interface TestResult {
  ok: boolean;
  value?: ListToolsValue;
  servers?: Array<{
    id: string;
    runtimeStatus?: string;
    runtimeError?: string;
  }>;
  error?: { kind: string; detail: string };
}

async function registerHandlers(): Promise<Map<string, IpcHandler>> {
  const { registerMcpIpc } = await import("../mcp-service");
  const { ipcMain } = await import("electron");
  vi.mocked(ipcMain.handle).mockClear();
  registerMcpIpc();
  return new Map(
    vi
      .mocked(ipcMain.handle)
      .mock.calls.map((c) => [String(c[0]), c[1] as IpcHandler]),
  );
}

async function registerAndGetRunOp(): Promise<
  (
    e: unknown,
    input: { op: string; args?: Record<string, unknown> },
  ) => Promise<TestResult>
> {
  const handlers = await registerHandlers();
  const runOp = handlers.get("mcp:runOp");
  if (!runOp) throw new Error("mcp:runOp handler not registered");
  return runOp as (
    e: unknown,
    input: { op: string; args?: Record<string, unknown> },
  ) => Promise<TestResult>;
}

describe("mcp-service SDK client", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "MCP_REMOTE_HTTP_ENABLED");
    fixture.servers = [{ ...STDIO_SERVER }];
    connect.mockReset();
    listTools.mockReset();
    callTool.mockReset();
    clientClose.mockReset();
    transportClose.mockReset();
    getDefaultEnvironment.mockClear();
    onDataHandlers.length = 0;
    transportCtorArgs.length = 0;
    httpCtorArgs.length = 0;
    connect.mockResolvedValue(undefined);
    listTools.mockResolvedValue({
      tools: [
        {
          name: "ping",
          description: "Ping",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    callTool.mockResolvedValue({
      content: [{ type: "text", text: "pong" }],
    });
    clientClose.mockResolvedValue(undefined);
    transportClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "MCP_REMOTE_HTTP_ENABLED");
    Reflect.deleteProperty(process.env, "SECRET_LEAK_PROBE");
    vi.resetModules();
  });

  it("exports registerMcpIpc / shutdownAllMcpSessions", async () => {
    const mod = await import("../mcp-service");
    expect(typeof mod.registerMcpIpc).toBe("function");
    expect(typeof mod.shutdownAllMcpSessions).toBe("function");
  });

  it("list_tools uses Client.connect + listTools", async () => {
    const handler = await registerAndGetRunOp();
    const result = await handler({}, { op: "list_tools" });
    expect(connect).toHaveBeenCalled();
    expect(listTools).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.value?.servers).toEqual([
      {
        id: "srv1",
        name: "Echo",
        status: "ready",
        tools: [
          {
            name: "ping",
            description: "Ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ]);
  });

  it("无 transport 字段的老配置仍按 stdio 走", async () => {
    const handler = await registerAndGetRunOp();
    await handler({}, { op: "list_tools" });
    expect(transportCtorArgs[0]?.command).toBe("npx");
    expect(httpCtorArgs.length).toBe(0);
  });

  it("spawnEnv uses getDefaultEnvironment + config.env (not full process.env)", async () => {
    process.env.SECRET_LEAK_PROBE = "should-not-inherit";
    const handler = await registerAndGetRunOp();
    await handler({}, { op: "list_tools" });
    expect(getDefaultEnvironment).toHaveBeenCalled();
    expect(transportCtorArgs.length).toBeGreaterThan(0);
    const env = transportCtorArgs[0]?.env || {};
    expect(env.PATH).toBe("/safe/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.MCP_TOKEN).toBe("from-config");
    expect(env.SECRET_LEAK_PROBE).toBeUndefined();
  });

  it("shutdownAllMcpSessions awaits killSession for live sessions", async () => {
    const handler = await registerAndGetRunOp();
    await handler({}, { op: "list_tools" });
    expect(clientClose).not.toHaveBeenCalled();
    const { shutdownAllMcpSessions } = await import("../mcp-service");
    await shutdownAllMcpSessions();
    expect(clientClose).toHaveBeenCalled();
    expect(transportClose).toHaveBeenCalled();
  });

  it("surfaces stderr tail on handshake failure", async () => {
    connect.mockImplementation(async () => {
      for (const cb of onDataHandlers) cb("spawn failed: missing binary\n");
      throw new Error("MCP 握手失败");
    });
    const handler = await registerAndGetRunOp();
    const result = await handler({}, { op: "list_tools" });
    expect(result.ok).toBe(true);
    const err = result.value?.servers?.[0]?.error || "";
    expect(err).toContain("MCP 握手失败");
    expect(err).toContain("MCP stderr");
    expect(err).toContain("spawn failed: missing binary");
  });

  it("call_tool forwards via client.callTool", async () => {
    const handler = await registerAndGetRunOp();
    const result = await handler(
      {},
      {
        op: "call_tool",
        args: {
          server_id: "srv1",
          tool_name: "ping",
          arguments: { x: 1 },
        },
      },
    );
    expect(callTool).toHaveBeenCalledWith({
      name: "ping",
      arguments: { x: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      content: [{ type: "text", text: "pong" }],
    });
  });
});

describe("远程 HTTP MCP（opt-in，默认关）", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "MCP_REMOTE_HTTP_ENABLED");
    fixture.servers = [{ ...STDIO_SERVER }, { ...HTTP_SERVER }];
    connect.mockReset().mockResolvedValue(undefined);
    listTools.mockReset().mockResolvedValue({ tools: [{ name: "ping" }] });
    clientClose.mockReset().mockResolvedValue(undefined);
    transportClose.mockReset().mockResolvedValue(undefined);
    transportCtorArgs.length = 0;
    httpCtorArgs.length = 0;
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "MCP_REMOTE_HTTP_ENABLED");
    vi.resetModules();
  });

  it("默认关：远程条目既不握手也不进 list_tools 回填", async () => {
    const handler = await registerAndGetRunOp();
    const result = await handler({}, { op: "list_tools" });
    expect(result.value?.servers?.map((s) => s.id)).toEqual(["srv1"]);
    expect(httpCtorArgs.length).toBe(0);
    expect(transportCtorArgs.length).toBe(1);
  });

  it("默认关：upsert 远程配置被拒，不写任何行", async () => {
    const handlers = await registerHandlers();
    const upsert = handlers.get("mcp:upsertServer") as (
      e: unknown,
      cfg: typeof HTTP_SERVER,
    ) => Promise<TestResult>;
    const result = await upsert({}, { ...HTTP_SERVER, id: "" });
    expect(result.ok).toBe(false);
    expect(result.error?.detail).toContain("MCP_REMOTE_HTTP_ENABLED");
    const { writeFileSync } = await import("node:fs");
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("默认关：listServers 保留配置并明确标注不可用原因", async () => {
    const handlers = await registerHandlers();
    const list = handlers.get("mcp:listServers") as () => Promise<TestResult>;
    const result = await list();
    const remote = result.servers?.find((s) => s.id === "remote1");
    expect(remote?.runtimeStatus).toBe("failed");
    expect(remote?.runtimeError).toContain("MCP_REMOTE_HTTP_ENABLED");
  });

  it("默认关：call_tool 与 testServer 都给出同一个开关提示", async () => {
    const handlers = await registerHandlers();
    const runOp = handlers.get("mcp:runOp") as (
      e: unknown,
      input: { op: string; args?: Record<string, unknown> },
    ) => Promise<TestResult>;
    const called = await runOp(
      {},
      { op: "call_tool", args: { server_id: "remote1", tool_name: "ping" } },
    );
    expect(called.ok).toBe(false);
    expect(called.error?.detail).toContain("MCP_REMOTE_HTTP_ENABLED");

    const test = handlers.get("mcp:testServer") as (
      e: unknown,
      id: string,
    ) => Promise<TestResult>;
    const tested = await test({}, "remote1");
    expect(tested.ok).toBe(false);
    expect(tested.error?.detail).toContain("MCP_REMOTE_HTTP_ENABLED");
  });

  it("实验开：走 StreamableHTTP 运输并传静态请求头，服务端 wire 不变", async () => {
    process.env.MCP_REMOTE_HTTP_ENABLED = "true";
    const handler = await registerAndGetRunOp();
    const result = await handler({}, { op: "list_tools" });
    expect(result.value?.servers?.map((s) => s.id)).toEqual([
      "srv1",
      "remote1",
    ]);
    expect(result.value?.servers?.[1]?.status).toBe("ready");
    expect(httpCtorArgs).toHaveLength(1);
    expect(httpCtorArgs[0]?.url.toString()).toBe(HTTP_SERVER.url);
    expect(httpCtorArgs[0]?.opts.requestInit?.headers).toEqual(
      HTTP_SERVER.headers,
    );
    expect(typeof httpCtorArgs[0]?.opts.fetch).toBe("function");
  });

  it("实验开：非法 URL / 请求头整包拒绝", async () => {
    process.env.MCP_REMOTE_HTTP_ENABLED = "true";
    const handlers = await registerHandlers();
    const upsert = handlers.get("mcp:upsertServer") as (
      e: unknown,
      cfg: Record<string, unknown>,
    ) => Promise<TestResult>;
    const badUrl = await upsert(
      {},
      { ...HTTP_SERVER, url: "http://plain.example/mcp" },
    );
    expect(badUrl.ok).toBe(false);
    expect(badUrl.error?.detail).toContain("https");

    const badHeader = await upsert(
      {},
      { ...HTTP_SERVER, headers: { Host: "evil.example" } },
    );
    expect(badHeader.ok).toBe(false);
    expect(badHeader.error?.detail).toContain("请求头");
  });

  it("实验开：允许禁用远程条目，但不能启用未开实验的遗留条目", async () => {
    const handlers = await registerHandlers();
    const enable = handlers.get("mcp:setServerEnabled") as (
      e: unknown,
      id: string,
      enabled: boolean,
    ) => Promise<TestResult>;
    const blocked = await enable({}, "remote1", true);
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.detail).toContain("MCP_REMOTE_HTTP_ENABLED");
    const disabled = await enable({}, "remote1", false);
    expect(disabled.ok).toBe(true);
  });
});
