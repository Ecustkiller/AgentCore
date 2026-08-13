import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  bootstrapRequest,
  captureCsrf,
  clearCsrfToken,
  setSessionRenewedHandler,
  tryRefresh,
} from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionRenewedHandler(null);
  clearCsrfToken();
});

describe("request init", () => {
  /** Stub fetch with an empty 200 and hand back the recorded RequestInit. */
  function stubOk(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("merges caller headers into the defaults instead of replacing them", async () => {
    captureCsrf(
      new Response(null, { headers: { "X-CSRF-Token": "tok-merge" } }),
    );
    const fetchMock = stubOk();

    await bootstrapRequest("/v1/thing", {
      method: "POST",
      headers: { "X-Custom": "1" },
    });

    // `...options` used to be spread AFTER `headers`, so any caller-supplied
    // headers replaced the whole object — CSRF and Content-Type went with it.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual(
      expect.objectContaining({
        "X-Custom": "1",
        "Content-Type": "application/json",
        "X-CSRF-Token": "tok-merge",
      }),
    );
  });

  it("captures the token from any response, including raw-fetch paths", async () => {
    captureCsrf(new Response(null, { headers: { "X-CSRF-Token": "tok-raw" } }));
    const fetchMock = stubOk();

    await bootstrapRequest("/v1/thing", { method: "POST" });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "tok-raw",
    );
  });

  it("omits the CSRF header on safe methods", async () => {
    captureCsrf(new Response(null, { headers: { "X-CSRF-Token": "tok-get" } }));
    const fetchMock = stubOk();

    await bootstrapRequest("/v1/thing");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(
      (init.headers as Record<string, string>)["X-CSRF-Token"],
    ).toBeUndefined();
  });
});

describe("CSRF 403 replay", () => {
  /** The backend's CSRF refusal (middleware/csrf.py) as it reaches the client. */
  const CSRF_BODY = JSON.stringify({
    error: {
      code: "CSRF_FAILED",
      message: "CSRF token missing or invalid. Re-login and retry.",
    },
  });

  /** A refused write; `reissued` = the replacement token the server hands back. */
  function csrfRejection(reissued?: string): Response {
    return new Response(CSRF_BODY, {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        ...(reissued ? { "X-CSRF-Token": reissued } : {}),
      },
    });
  }

  function okJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sentToken = (init: unknown): string | undefined =>
    (((init as RequestInit).headers ?? {}) as Record<string, string>)[
      "X-CSRF-Token"
    ];

  it("replays the write once, carrying the token the 403 handed back", async () => {
    // Cold start: the token only lives in module memory, so the first write goes
    // out unarmed and the user used to eat the failure.
    let call = 0;
    const fetchMock = vi.fn((_url?: unknown, _init?: unknown) =>
      Promise.resolve(
        call++ === 0 ? csrfRejection("tok-reissued") : okJson({ id: "c1" }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.post("/v1/conversations", { title: "hi" }),
    ).resolves.toEqual({ id: "c1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentToken(fetchMock.mock.calls[0][1])).toBeUndefined();
    expect(sentToken(fetchMock.mock.calls[1][1])).toBe("tok-reissued");
  });

  it("throws as before when the 403 withheld a replacement token", async () => {
    // No header = the backend refusing to re-arm us on purpose (the presented
    // token was signed for another session). Replaying would write as that
    // session, so this one must stay a plain failure.
    const fetchMock = vi.fn(() => Promise.resolve(csrfRejection()));
    vi.stubGlobal("fetch", fetchMock);

    const err = await api
      .post("/v1/conversations", { title: "hi" })
      .catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("CSRF_FAILED");
  });

  it("does not replay a 403 that is not a CSRF rejection", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": "tok-fresh",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.post("/v1/conversations")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays at most once when the server keeps rejecting", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(csrfRejection("tok-again")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.post("/v1/conversations")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replays on the status-returning path too", async () => {
    let call = 0;
    const fetchMock = vi.fn((_url?: unknown, _init?: unknown) =>
      Promise.resolve(
        call++ === 0
          ? csrfRejection("tok-reissued")
          : okJson({ id: "c1" }, 201),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.postWithStatus("/v1/conversations")).resolves.toEqual({
      data: { id: "c1" },
      status: 201,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentToken(fetchMock.mock.calls[1][1])).toBe("tok-reissued");
  });
});

describe("tryRefresh single-flight + three-state", () => {
  afterEach(() => {
    // Ensure Electron outboxApi path does not short-circuit cookie refresh tests.
    if (typeof globalThis !== "undefined" && "window" in globalThis) {
      Reflect.deleteProperty(
        (globalThis as { window?: object }).window as object,
        "outboxApi",
      );
    }
  });

  it("collapses concurrent refreshes into one /refresh round-trip", async () => {
    // A pending fetch that we resolve only after all three callers have raced in,
    // so the dedup (not fetch timing) is what keeps it to a single request.
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const fetchMock = vi.fn((_url?: unknown) => pending);
    vi.stubGlobal("fetch", fetchMock);

    const all = Promise.all([tryRefresh(), tryRefresh(), tryRefresh()]);
    release(new Response(null, { status: 200 }));

    expect(await all).toEqual(["renewed", "renewed", "renewed"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/auth/refresh");
  });

  it("starts a fresh refresh once the in-flight one has settled", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await tryRefresh()).toBe("renewed");
    expect(await tryRefresh()).toBe("renewed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns auth_dead on 401 and resets so a later attempt can retry", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await tryRefresh()).toBe("auth_dead");
    // Not stuck on the previous (failed) promise — a new round-trip is issued.
    expect(await tryRefresh()).toBe("auth_dead");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns transient on transport errors (non-throwing)", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(tryRefresh()).resolves.toBe("transient");
  });

  it("returns transient on 5xx", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await tryRefresh()).toBe("transient");
  });

  it("fires onSessionRenewed when outboxApi authRefresh renews", async () => {
    const renewed = vi.fn();
    setSessionRenewedHandler(renewed);
    const authRefresh = vi.fn(async () => "renewed" as const);
    vi.stubGlobal("window", { outboxApi: { authRefresh } });

    expect(await tryRefresh()).toBe("renewed");
    expect(authRefresh).toHaveBeenCalledOnce();
    expect(renewed).toHaveBeenCalledOnce();
  });

  it("does not fire onSessionRenewed on outboxApi transient", async () => {
    const renewed = vi.fn();
    setSessionRenewedHandler(renewed);
    const authRefresh = vi.fn(async () => "transient" as const);
    vi.stubGlobal("window", { outboxApi: { authRefresh } });

    expect(await tryRefresh()).toBe("transient");
    expect(renewed).not.toHaveBeenCalled();
  });
});
