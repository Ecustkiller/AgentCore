import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  clearCsrfToken,
  errorMessage,
  errorMessageOr,
  tryRefresh,
} from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // `csrfToken` is module state — without this a token seeded by one test leaks
  // into the next and quietly makes its assertions vacuous.
  clearCsrfToken();
});

describe("tryRefresh single-flight", () => {
  it("collapses concurrent refreshes into one /refresh round-trip", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const fetchMock = vi.fn((_url?: unknown) => pending);
    vi.stubGlobal("fetch", fetchMock);

    const all = Promise.all([tryRefresh(), tryRefresh(), tryRefresh()]);
    release(new Response(null, { status: 200 }));

    expect(await all).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v1/auth/refresh");
  });

  it("starts a fresh refresh once the in-flight one has settled", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await tryRefresh()).toBe(true);
    expect(await tryRefresh()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false on failure and allows a later retry", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await tryRefresh()).toBe(false);
    expect(await tryRefresh()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

interface Sent {
  url: string;
  init: RequestInit;
}

/** Stub `fetch` and record every `(url, init)` the client actually sent. */
function stubFetch(respond: (nth: number) => Response): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(respond(sent.length - 1));
    }),
  );
  return sent;
}

function headersOf(sent: Sent[], index: number): Record<string, string> {
  return (sent[index]?.init.headers ?? {}) as Record<string, string>;
}

function jsonOk(csrf?: string): Response {
  return new Response("{}", {
    status: 200,
    headers: csrf ? { "X-CSRF-Token": csrf } : {},
  });
}

/**
 * The backend's real CSRF rejection (English on purpose — see errorMessage).
 * `rotated` mirrors the backend's own split: it re-arms a client that merely holds
 * no usable token, and withholds the header when the presented one was signed for
 * a *different* session (agentcore/middleware/csrf.py).
 */
function csrfRejection(rotated?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "CSRF_FAILED",
        message: "CSRF token missing or invalid. Re-login and retry.",
      },
    }),
    { status: 403, headers: rotated ? { "X-CSRF-Token": rotated } : {} },
  );
}

/**
 * CSRF is the console's most expensive silent failure: a client holding a live
 * session but no token 403s every mutating request while every GET keeps working,
 * which reads to the operator as "the app ignores my clicks".
 */
describe("CSRF token", () => {
  it("captures a token off whatever response carries one", async () => {
    // The backend issues on the handshake and on the 403 that re-arms — never on a
    // plain read. The client does not try to predict which: it reads the header off
    // every response, so it can never be the reason a re-arm is missed.
    const sent = stubFetch(() => jsonOk("t1"));

    await api.get("/v1/admin/users");
    await api.post("/v1/admin/notices", { title: "x" });

    expect(headersOf(sent, 0)["X-CSRF-Token"]).toBeUndefined();
    expect(headersOf(sent, 1)["X-CSRF-Token"]).toBe("t1");
  });

  it("picks up a rotated token from an error response too", async () => {
    const sent = stubFetch((nth) =>
      nth === 1 ? csrfRejection("fresh") : jsonOk(nth === 0 ? "stale" : undefined),
    );

    await api.get("/v1/admin/users");
    await api.post("/v1/admin/notices", {});

    expect(headersOf(sent, 1)["X-CSRF-Token"]).toBe("stale");
    expect(headersOf(sent, 2)["X-CSRF-Token"]).toBe("fresh");
  });

  it("attaches the token to unsafe methods only", async () => {
    const sent = stubFetch(() => jsonOk("t1"));
    await api.get("/v1/admin/users"); // seed

    await api.get("/v1/admin/users");
    await api.get("/v1/admin/users", { method: "HEAD" });
    await api.post("/v1/admin/notices", {});
    await api.put("/v1/admin/notices/n1", {});
    await api.patch("/v1/admin/notices/n1", {});
    await api.delete("/v1/admin/notices/n1");

    const carried = sent
      .slice(1)
      .map((call) => (call.init.headers as Record<string, string>)["X-CSRF-Token"]);
    expect(carried).toEqual([undefined, undefined, "t1", "t1", "t1", "t1"]);
  });

  it("sends no token before one has ever been issued", async () => {
    const sent = stubFetch(() => jsonOk());

    await api.post("/v1/admin/notices", {});

    expect(headersOf(sent, 0)["X-CSRF-Token"]).toBeUndefined();
  });

  it("keeps CSRF and Content-Type when the caller passes its own headers", async () => {
    const sent = stubFetch(() => jsonOk("t1"));
    await api.get("/v1/admin/users"); // seed

    await api.get("/v1/admin/notices", {
      method: "POST",
      headers: { "X-Trace-Id": "abc" },
    });

    const merged = headersOf(sent, 1);
    expect(merged["X-CSRF-Token"]).toBe("t1");
    expect(merged["Content-Type"]).toBe("application/json");
    expect(merged["X-Trace-Id"]).toBe("abc");
  });

  it("still forwards the rest of the caller's init (abort signal)", async () => {
    const sent = stubFetch(() => jsonOk());
    const controller = new AbortController();

    await api.get("/v1/admin/users", { signal: controller.signal });

    expect(sent[0]?.init.signal).toBe(controller.signal);
    expect(sent[0]?.init.credentials).toBe("include");
  });

  // Whether to replay a CSRF 403 turns on one bit, and the backend has already
  // computed it: a rejection that hands a token back says this session re-armed,
  // so the write will land where it was aimed. The client adds no guess of its own,
  // and the two shapes of that 403 are the whole boundary.
  it("replays a CSRF 403 once when the rejection re-armed the session", async () => {
    const sent = stubFetch((nth) => (nth === 0 ? csrfRejection("fresh") : jsonOk()));

    await expect(api.delete("/v1/admin/notices/n1")).resolves.toEqual({});

    expect(sent).toHaveLength(2);
    // The *same* request, re-sent with the token the rejection just issued.
    expect(sent[1]?.url).toBe(sent[0]?.url);
    expect(sent[1]?.init.method).toBe("DELETE");
    expect(headersOf(sent, 0)["X-CSRF-Token"]).toBeUndefined();
    expect(headersOf(sent, 1)["X-CSRF-Token"]).toBe("fresh");
  });

  it("does not replay a CSRF 403 that withheld a token — the operator decides", async () => {
    // The original worry, now stated precisely instead of applied to every 403: a
    // silent replay loop would hide a session that never re-arms behind an action
    // that looks like it worked. The backend withholds the token on exactly that
    // session (a token minted for another account gets no re-issue), because
    // re-arming would let the retry land the write on whoever owns the cookie now.
    const sent = stubFetch(() => csrfRejection());

    const err = await api.delete("/v1/admin/notices/n1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("CSRF_FAILED");
    expect(sent).toHaveLength(1);
  });

  it("stops after the one replay when the retry is rejected too", async () => {
    // Re-armed and still rejected means the token was never the problem, so the
    // replay must not become a loop that keeps a broken session invisible.
    const sent = stubFetch(() => csrfRejection("fresh"));

    const err = await api.post("/v1/admin/notices", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("CSRF_FAILED");
    expect(sent).toHaveLength(2);
  });

  it("replays no other 403, even one that carries a token", async () => {
    // The replay keys on CSRF_FAILED, not on the header alone: a permission 403 is
    // an answer, not a re-arm, and repeating it would just fail twice as loudly.
    const sent = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "ADMIN_REQUIRED", message: "当前账号不是平台管理员" },
          }),
          { status: 403, headers: { "X-CSRF-Token": "fresh" } },
        ),
    );

    const err = await api.delete("/v1/admin/notices/n1").catch((e: unknown) => e);

    expect((err as ApiError).code).toBe("ADMIN_REQUIRED");
    expect(sent).toHaveLength(1);
  });
});

describe("errorMessage", () => {
  it("phrases a CSRF 403 in zh with a next step, not the backend's English", () => {
    const err = new ApiError(
      403,
      JSON.stringify({
        error: {
          code: "CSRF_FAILED",
          message: "CSRF token missing or invalid. Re-login and retry.",
        },
      }),
    );

    const message = errorMessage(err);
    expect(message).not.toMatch(/CSRF/i);
    // 能弹到操作者面前的只剩「重放救不了」的那半（后端不补票，或补了票重放仍被拒）：
    // 手动重来成本低仍值得提，但刷新页面 / 重新登录同样无济于事，别把文案升级成那两步。
    expect(message).toContain("请重试");
    expect(message).not.toMatch(/刷新页面|重新登录/);
  });

  it("still prefers the backend's own zh message for other failures", () => {
    const err = new ApiError(
      403,
      JSON.stringify({
        error: { code: "ADMIN_REQUIRED", message: "当前账号不是平台管理员" },
      }),
    );

    expect(errorMessage(err)).toBe("当前账号不是平台管理员");
  });
});

/** Forms keep their own fallback wording, but must not reach past our CSRF phrasing. */
describe("errorMessageOr", () => {
  it("prefers our CSRF copy over both the backend string and the fallback", () => {
    const err = new ApiError(
      403,
      JSON.stringify({
        error: {
          code: "CSRF_FAILED",
          message: "CSRF token missing or invalid. Re-login and retry.",
        },
      }),
    );

    const message = errorMessageOr(err, "修改失败，请重试");
    expect(message).not.toMatch(/CSRF/i);
    expect(message).toBe("安全校验未通过，请重试");
  });

  it("passes the backend message through, and falls back when there is none", () => {
    const withMessage = new ApiError(
      400,
      JSON.stringify({ error: { code: "BAD_REQUEST", message: "当前密码不正确" } }),
    );

    expect(errorMessageOr(withMessage, "修改失败，请重试")).toBe("当前密码不正确");
    expect(errorMessageOr(new ApiError(500, "<html>"), "修改失败，请重试")).toBe(
      "修改失败，请重试",
    );
    expect(errorMessageOr(new Error("boom"), "修改失败，请重试")).toBe(
      "修改失败，请重试",
    );
  });
});
