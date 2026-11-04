/**
 * 远程 MCP 实验运输的纯策略测试（生成 / 最后修订 2026-11-04）。
 *
 * 重点不是「能连上」，而是默认关、URL / 请求头 fail closed、跨源重定向拒绝，
 * 以及 capabilities 如实声明没做的部分。
 */
import { describe, expect, it } from "vitest";
import {
  REMOTE_MCP_CAPABILITIES,
  REMOTE_MCP_DISABLED_HINT,
  REMOTE_MCP_ENV_FLAG,
  createGuardedFetch,
  remoteMcpEnabled,
  sameMcpOrigin,
  validateRemoteHeaders,
  validateRemoteUrl,
} from "../mcp-remote";

const GOOD_URL = "https://mcp.example.com/mcp";

describe("remoteMcpEnabled", () => {
  it("默认关，只有字面 true 才开", () => {
    expect(remoteMcpEnabled({})).toBe(false);
    expect(remoteMcpEnabled({ [REMOTE_MCP_ENV_FLAG]: "1" })).toBe(false);
    expect(remoteMcpEnabled({ [REMOTE_MCP_ENV_FLAG]: "TRUE" })).toBe(false);
    expect(remoteMcpEnabled({ [REMOTE_MCP_ENV_FLAG]: "true " })).toBe(false);
    expect(remoteMcpEnabled({ [REMOTE_MCP_ENV_FLAG]: "true" })).toBe(true);
  });

  it("capabilities 如实声明尚未实现的能力", () => {
    expect(REMOTE_MCP_CAPABILITIES.enabled_by_default).toBe(false);
    expect(REMOTE_MCP_CAPABILITIES.url_scheme).toBe("https only");
    expect(REMOTE_MCP_CAPABILITIES.agentcore_as_mcp_server).toBe(false);
    expect(REMOTE_MCP_CAPABILITIES.folder_or_agent_binding).toBe(false);
    expect(REMOTE_MCP_CAPABILITIES.server_wire_unchanged).toBe(true);
    expect(REMOTE_MCP_DISABLED_HINT).toContain(REMOTE_MCP_ENV_FLAG);
  });
});

describe("validateRemoteUrl", () => {
  it("接受干净的 https 端点", () => {
    const verdict = validateRemoteUrl(GOOD_URL);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url.toString()).toBe(GOOD_URL);
  });

  it.each([
    ["http 明文", "http://mcp.example.com/mcp"],
    ["回环 http", "http://127.0.0.1:8080/mcp"],
    ["file scheme", "file:///etc/passwd"],
    ["ws scheme", "wss://mcp.example.com/mcp"],
    ["内嵌凭据", "https://user:secret@mcp.example.com/mcp"],
    ["fragment", "https://mcp.example.com/mcp#x"],
    ["空白", "https://mcp.example.com/m cp"],
    ["控制字符", "https://mcp.example.com/m\u0000cp"],
    ["反斜杠", "https://mcp.example.com\\@evil.example/mcp"],
    ["不可解析", "not-a-url"],
    ["非字符串", 42],
  ])("拒绝 %s", (_label, value) => {
    const verdict = validateRemoteUrl(value);
    expect(verdict.ok).toBe(false);
  });

  it("拒绝空值与超长 URL", () => {
    expect(validateRemoteUrl("  ").ok).toBe(false);
    expect(validateRemoteUrl(`https://x.example/${"a".repeat(2100)}`).ok).toBe(
      false,
    );
  });
});

describe("validateRemoteHeaders", () => {
  it("缺省即空对象，合法头原样通过", () => {
    expect(validateRemoteHeaders(undefined)).toEqual({
      ok: true,
      headers: {},
    });
    expect(
      validateRemoteHeaders({
        Authorization: "Bearer abc",
        "X-Tenant": "t1",
      }),
    ).toEqual({
      ok: true,
      headers: { Authorization: "Bearer abc", "X-Tenant": "t1" },
    });
  });

  it.each([
    ["transport 管理的头", { Host: "evil.example" }],
    ["connection", { Connection: "keep-alive" }],
    ["非法头名", { "Bad Header": "x" }],
    ["非字符串值", { "X-A": 1 }],
    ["换行注入", { "X-A": "a\r\nX-Evil: 1" }],
    ["控制字符", { "X-A": "a\u0000b" }],
    ["数组", ["a"]],
  ])("拒绝 %s", (_label, value) => {
    const verdict = validateRemoteHeaders(value);
    expect(verdict.ok).toBe(false);
  });

  it("拒绝超限（数量 / 单值长度）", () => {
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`X-${i}`, "v"]),
    );
    expect(validateRemoteHeaders(many).ok).toBe(false);
    expect(validateRemoteHeaders({ "X-A": "v".repeat(4097) }).ok).toBe(false);
  });
});

describe("sameMcpOrigin / createGuardedFetch", () => {
  it("origin 比较含端口与协议", () => {
    expect(sameMcpOrigin(GOOD_URL, "https://mcp.example.com/other")).toBe(true);
    expect(sameMcpOrigin(GOOD_URL, "https://mcp.example.com:444/mcp")).toBe(
      false,
    );
    expect(sameMcpOrigin(GOOD_URL, "https://evil.example/mcp")).toBe(false);
    expect(sameMcpOrigin(GOOD_URL, "not-a-url")).toBe(false);
  });

  it("合法请求原样转发，不改 SDK 的 init", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const guarded = createGuardedFetch(GOOD_URL, async (url, init) => {
      seen.push({ url: url.toString(), init });
      return new Response("ok");
    });
    const init: RequestInit = {
      method: "POST",
      headers: { Accept: "application/json" },
    };
    const res = await guarded(new URL(GOOD_URL), init);
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ url: GOOD_URL, init }]);
  });

  it("SDK 换到别的源时在发出前拒绝", async () => {
    const baseFetch = async () => new Response("ok");
    const guarded = createGuardedFetch(GOOD_URL, baseFetch);
    await expect(guarded("https://evil.example/mcp", {})).rejects.toThrow(
      /不得离开配置里的源/,
    );
    await expect(guarded("http://mcp.example.com/mcp", {})).rejects.toThrow(
      /URL 校验失败/,
    );
  });

  it("跨源重定向即使 baseFetch 成功也要拒绝", async () => {
    const baseFetch = async () => {
      const res = new Response("ok");
      Object.defineProperty(res, "url", {
        value: "https://evil.example/mcp",
      });
      return res;
    };
    const guarded = createGuardedFetch(GOOD_URL, baseFetch);
    await expect(guarded(new URL(GOOD_URL), {})).rejects.toThrow(
      /不允许跨源重定向/,
    );
  });

  it("同源重定向放行", async () => {
    const baseFetch = async () => {
      const res = new Response("ok");
      Object.defineProperty(res, "url", {
        value: "https://mcp.example.com/mcp/session",
      });
      return res;
    };
    const guarded = createGuardedFetch(GOOD_URL, baseFetch);
    await expect(guarded(new URL(GOOD_URL), {})).resolves.toBeInstanceOf(
      Response,
    );
  });
});
