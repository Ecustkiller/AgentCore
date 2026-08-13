/**
 * Bridge handler 扩展测：health / navigate / command 六动作 / host_unavailable，
 * 以及 token 滑动续期（长回合中途不掉线）与重复启动不作废在飞 token。
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // 打包态：跳过 dev 凭证落盘，测试不碰 userData。
  app: { isPackaged: true },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  WebContentsView: vi.fn(),
  session: {
    fromPartition: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      protocol: { handle: vi.fn() },
      on: vi.fn(),
    })),
  },
}));

import {
  getDesktopBrowserBridgeCredentials,
  startDesktopBrowserBridge,
  stopDesktopBrowserBridge,
} from "../browser/bridge";
import {
  type BridgeDispatch,
  type BridgeHostResult,
  createBridgeAuth,
  handleBridgeRequest,
} from "../browser/bridge-handler";

function mockReqRes(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): {
  req: IncomingMessage;
  res: ServerResponse;
  statusCode: () => number;
  body: () => string;
} {
  let status = 0;
  let responseBody = "";

  const req = {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (opts.body) yield Buffer.from(opts.body);
    },
  } as unknown as IncomingMessage;

  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(data?: string) {
      responseBody = data ?? "";
    },
  } as unknown as ServerResponse;

  return {
    req,
    res,
    statusCode: () => status,
    body: () => responseBody,
  };
}

function okDispatch(
  impl?: (
    pageId: string,
    action: string,
    args: Record<string, unknown>,
    conversationId: string,
  ) => BridgeHostResult,
): BridgeDispatch {
  return async (pageId, action, args, conversationId) => {
    if (impl) return impl(pageId, action, args, conversationId);
    return {
      ok: true,
      data: {
        final_url: "https://example.com/",
        title: "Example",
        action,
        conversationId,
      },
    };
  };
}

describe("createBridgeAuth", () => {
  it("rejects missing / wrong / expired tokens", () => {
    let now = 1_000;
    const auth = createBridgeAuth(() => now);
    expect(auth.validateToken(null)).toBe(false);
    expect(auth.validateToken("nope")).toBe(false);
    const token = auth.issueToken(100);
    expect(auth.validateToken(token)).toBe(true);
    expect(auth.validateToken("other")).toBe(false);
    now = 1_200;
    expect(auth.validateToken(token)).toBe(false);
  });

  it("每次成功校验顺延到期；失效后不复活", () => {
    let now = 1_000;
    const auth = createBridgeAuth(() => now);
    const token = auth.issueToken(100);
    expect(auth.state.expiresAt).toBe(1_100);

    now = 1_080;
    expect(auth.validateToken(token)).toBe(true);
    expect(auth.state.expiresAt).toBe(1_180);

    now = 1_100;
    expect(auth.validateToken("other")).toBe(false);
    expect(auth.state.expiresAt).toBe(1_180); // 错 token 不续期

    now = 1_180; // 闲置刚好满一个 TTL
    expect(auth.validateToken(token)).toBe(false);
    now = 1_181;
    expect(auth.validateToken(token)).toBe(false);
  });
});

describe("handleBridgeRequest", () => {
  it("returns 401 without token", async () => {
    const auth = createBridgeAuth();
    auth.issueToken();
    const { req, res, statusCode, body } = mockReqRes({
      method: "GET",
      url: "/health",
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch(),
    );
    expect(statusCode()).toBe(401);
    expect(JSON.parse(body())).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
  });

  it("returns 401 with wrong token", async () => {
    const auth = createBridgeAuth();
    auth.issueToken();
    const { req, res, statusCode } = mockReqRes({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer wrong-token" },
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch(),
    );
    expect(statusCode()).toBe(401);
  });

  it("health ok with valid token", async () => {
    const auth = createBridgeAuth();
    const token = auth.issueToken();
    const { req, res, statusCode, body } = mockReqRes({
      method: "GET",
      url: "/health",
      headers: { authorization: `Bearer ${token}` },
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch(),
    );
    expect(statusCode()).toBe(200);
    expect(JSON.parse(body())).toMatchObject({
      ok: true,
      service: "desktop-browser-bridge",
    });
  });

  it("navigate accepts pageId+url+conversationId with token", async () => {
    const auth = createBridgeAuth();
    const token = auth.issueToken();
    const calls: {
      pageId: string;
      action: string;
      args: Record<string, unknown>;
      conversationId: string;
    }[] = [];
    const { req, res, statusCode, body } = mockReqRes({
      method: "POST",
      url: "/navigate",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageId: "browser-page:1",
        conversationId: "conv-a",
        url: "https://example.com",
      }),
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch((pageId, action, args, conversationId) => {
        calls.push({ pageId, action, args, conversationId });
        return { ok: true, data: { final_url: args.url as string } };
      }),
    );
    expect(statusCode()).toBe(200);
    expect(JSON.parse(body()).ok).toBe(true);
    expect(calls).toEqual([
      {
        pageId: "browser-page:1",
        action: "navigate",
        args: { url: "https://example.com" },
        conversationId: "conv-a",
      },
    ]);
  });

  it("navigate without conversationId → 400 and does not dispatch", async () => {
    const auth = createBridgeAuth();
    const token = auth.issueToken();
    let dispatched = false;
    const { req, res, statusCode, body } = mockReqRes({
      method: "POST",
      url: "/navigate",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageId: "browser-page:1",
        url: "https://example.com",
      }),
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch(() => {
        dispatched = true;
        return { ok: true };
      }),
    );
    expect(statusCode()).toBe(400);
    expect(JSON.parse(body())).toMatchObject({
      ok: false,
      error: "missing_conversationId",
    });
    expect(dispatched).toBe(false);
  });

  it("command navigate dispatches workspace:// url unchanged", async () => {
    const auth = createBridgeAuth();
    const token = auth.issueToken();
    let seen: Record<string, unknown> | null = null;
    let seenCid = "";
    const { req, res, statusCode, body } = mockReqRes({
      method: "POST",
      url: "/command",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageId: "sess-ws",
        conversationId: "c1",
        action: "navigate",
        args: { url: "workspace://c1/site/index.html" },
      }),
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch((_p, _a, args, conversationId) => {
        seen = args;
        seenCid = conversationId;
        return { ok: true, data: { final_url: args.url as string } };
      }),
    );
    expect(statusCode()).toBe(200);
    expect(JSON.parse(body()).ok).toBe(true);
    expect(seen).toEqual({ url: "workspace://c1/site/index.html" });
    expect(seenCid).toBe("c1");
  });

  it("command without conversationId → 400 and does not dispatch", async () => {
    const auth = createBridgeAuth();
    const token = auth.issueToken();
    let dispatched = false;
    const { req, res, statusCode, body } = mockReqRes({
      method: "POST",
      url: "/command",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageId: "p1",
        action: "navigate",
        args: { url: "https://x.test" },
      }),
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch(() => {
        dispatched = true;
        return { ok: true };
      }),
    );
    expect(statusCode()).toBe(400);
    expect(JSON.parse(body())).toMatchObject({
      ok: false,
      error: "missing_conversationId",
    });
    expect(dispatched).toBe(false);
  });

  it("command dispatches click/type/scroll/snapshot/screenshot/console", async () => {
    const auth = createBridgeAuth();
    const token = auth.issueToken();
    const seen: string[] = [];
    for (const action of [
      "click",
      "type",
      "scroll",
      "snapshot",
      "screenshot",
      "console",
    ] as const) {
      const { req, res, statusCode, body } = mockReqRes({
        method: "POST",
        url: "/command",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          session_id: "sess-1",
          conversationId: "conv-1",
          action,
          args:
            action === "type"
              ? { ref: "e1", text: "hi" }
              : { ref: "e1", dy: 100 },
        }),
      });
      await handleBridgeRequest(
        req,
        res,
        (t) => auth.validateToken(t),
        okDispatch((_p, a) => {
          seen.push(a);
          return { ok: true, data: { action: a } };
        }),
      );
      expect(statusCode()).toBe(200);
      expect(JSON.parse(body())).toMatchObject({ ok: true });
    }
    expect(seen).toEqual([
      "click",
      "type",
      "scroll",
      "snapshot",
      "screenshot",
      "console",
    ]);
  });

  it("maps host_unavailable to 503", async () => {
    const auth = createBridgeAuth();
    const token = auth.issueToken();
    const { req, res, statusCode, body } = mockReqRes({
      method: "POST",
      url: "/command",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageId: "p1",
        conversationId: "c1",
        action: "navigate",
        args: { url: "https://x.test" },
      }),
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      async () => ({
        ok: false,
        error: "host_unavailable: no window",
        code: "host_unavailable",
      }),
    );
    expect(statusCode()).toBe(503);
    expect(JSON.parse(body())).toMatchObject({
      ok: false,
      code: "host_unavailable",
    });
  });
});

describe("token 生命周期跟随使用（长回合中途不 401）", () => {
  const TTL = 100;

  async function command(
    auth: ReturnType<typeof createBridgeAuth>,
    token: string,
    action: string,
  ): Promise<number> {
    const { req, res, statusCode } = mockReqRes({
      method: "POST",
      url: "/command",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageId: "sess-1",
        conversationId: "c1",
        action,
        args: action === "navigate" ? { url: "https://example.com" } : {},
      }),
    });
    await handleBridgeRequest(
      req,
      res,
      (t) => auth.validateToken(t),
      okDispatch(),
    );
    return statusCode();
  }

  it("navigate 成功后越过原到期时刻，后续 snapshot 仍放行", async () => {
    let now = 1_000;
    const auth = createBridgeAuth(() => now);
    const token = auth.issueToken(TTL); // 绝对语义下 1_100 到期

    now = 1_090;
    expect(await command(auth, token, "navigate")).toBe(200);

    // 凭证只在回合边界下发，本回合内补不上；绝对过期会让这一步开始 401。
    now = 1_150;
    expect(await command(auth, token, "snapshot")).toBe(200);

    now = 1_240;
    expect(await command(auth, token, "screenshot")).toBe(200);
  });

  it("闲置超过 TTL 才失效", async () => {
    let now = 1_000;
    const auth = createBridgeAuth(() => now);
    const token = auth.issueToken(TTL);

    now = 1_090;
    expect(await command(auth, token, "navigate")).toBe(200);

    now = 1_190; // 距上次成功校验刚好一个 TTL，其间无请求
    expect(await command(auth, token, "snapshot")).toBe(401);
  });
});

describe("startDesktopBrowserBridge 幂等", () => {
  afterEach(async () => {
    await stopDesktopBrowserBridge();
  });

  it("重复启动复用同一 token，不作废在飞请求", async () => {
    const first = await startDesktopBrowserBridge();
    const second = await startDesktopBrowserBridge();

    expect(second.baseUrl).toBe(first.baseUrl);
    expect(second.token).toBe(first.token);
    expect(getDesktopBrowserBridgeCredentials()?.token).toBe(first.token);

    // sidecar 按 rootId 分进程：另一进程持首个 token 的在飞请求必须仍被接受。
    const res = await fetch(`${first.baseUrl}/health`, {
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("bridge loopback bind (smoke)", () => {
  it("can listen on 127.0.0.1 only", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    expect(addr && typeof addr !== "string" && addr.address).toBe("127.0.0.1");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
