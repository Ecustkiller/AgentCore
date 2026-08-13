import {
  ApiError,
  NetworkError,
  captureCsrf,
  clearCsrfToken,
  setServiceUnavailableHandler,
  setUnauthorizedHandler,
} from "@/services/api";
import { authedFetch } from "@/services/workspaceHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The raw-bytes seam (uploads, downloads, exports, snapshot zips, merge diffs)
 * must recover from the same failures `api.request` does — a CSRF token that is
 * missing or has rotated used to self-heal for every JSON write while these
 * hard-failed. Both recoveries hinge on rebuilding the request headers per
 * attempt, so every assertion below checks the token actually presented on the
 * wire, not just the number of attempts.
 */

const TARGET = "http://localhost:8000/v1/workspaces/ws-1/files/notes.txt";

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

/**
 * Script the file endpoint's responses in order; `/v1/auth/refresh` is answered
 * separately so the real `tryRefresh` (and the CSRF rotation it carries) runs
 * unmocked. `sentTokens` records the `X-CSRF-Token` presented on each
 * attempt against the file endpoint — refresh round-trips excluded, so its
 * length is the attempt count the replay budget is about.
 */
function stubFetch(
  responses: Response[],
  refresh?: () => Response,
): { sentTokens: (string | undefined)[] } {
  const queue = [...responses];
  const sentTokens: (string | undefined)[] = [];
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    if (String(input).includes("/v1/auth/refresh")) {
      return Promise.resolve(
        refresh?.() ?? new Response(null, { status: 503 }),
      );
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sentTokens.push(headers["X-CSRF-Token"]);
    const next = queue.shift();
    if (!next) {
      throw new Error(`attempt #${sentTokens.length} — the replay looped`);
    }
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sentTokens };
}

/** A refresh that succeeds and rotates the CSRF token, as the backend does. */
const renewingRefresh = (rotated: string) => (): Response =>
  new Response(null, { status: 200, headers: { "X-CSRF-Token": rotated } });

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
  setServiceUnavailableHandler(null);
  clearCsrfToken();
});

describe("authedFetch — CSRF 403 replay", () => {
  it("replays the write once, carrying the token the 403 handed back", async () => {
    captureCsrf(
      new Response(null, { headers: { "X-CSRF-Token": "tok-stale" } }),
    );
    const { sentTokens } = stubFetch([
      csrfRejection("tok-reissued"),
      new Response("ok", { status: 200 }),
    ]);

    const res = await authedFetch(TARGET, { method: "POST", body: "bytes" });

    expect(res.status).toBe(200);
    // Headers used to be computed once before the first send, so the replay
    // re-presented the very token the server had just replaced.
    expect(sentTokens).toEqual(["tok-stale", "tok-reissued"]);
  });

  it("arms a cold start that had no token at all", async () => {
    const { sentTokens } = stubFetch([
      csrfRejection("tok-first"),
      new Response("ok", { status: 200 }),
    ]);

    await expect(
      authedFetch(TARGET, { method: "POST", body: "bytes" }),
    ).resolves.toBeInstanceOf(Response);
    expect(sentTokens).toEqual([undefined, "tok-first"]);
  });

  it("throws a 403 that withheld a replacement token, without resending", async () => {
    // No header = the backend declining to re-arm us on purpose (the presented
    // token was signed for another session). Replaying would write as *that*
    // session, so this one must stay a plain failure.
    const { sentTokens } = stubFetch([csrfRejection()]);

    const err = await authedFetch(TARGET, { method: "POST" }).catch(
      (e: unknown) => e,
    );

    expect(sentTokens).toHaveLength(1);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).code).toBe("CSRF_FAILED");
  });

  it("does not replay a 403 that is not a CSRF rejection", async () => {
    const { sentTokens } = stubFetch([
      new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "tok-fresh",
        },
      }),
    ]);

    await expect(
      authedFetch(TARGET, { method: "POST" }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(sentTokens).toHaveLength(1);
  });

  it("replays at most once when the server keeps rejecting", async () => {
    const { sentTokens } = stubFetch([
      csrfRejection("tok-a"),
      csrfRejection("tok-b"),
    ]);

    await expect(
      authedFetch(TARGET, { method: "POST" }),
    ).rejects.toBeInstanceOf(ApiError);
    // A third attempt would have thrown out of the stub — one extra try, no loop.
    expect(sentTokens).toEqual([undefined, "tok-a"]);
  });
});

describe("authedFetch — 401 three-state", () => {
  it("refreshes and replays with the token the refresh rotated in", async () => {
    captureCsrf(
      new Response(null, { headers: { "X-CSRF-Token": "tok-before" } }),
    );
    const { sentTokens } = stubFetch(
      [
        new Response(null, { status: 401 }),
        new Response("ok", { status: 200 }),
      ],
      renewingRefresh("tok-rotated"),
    );

    const res = await authedFetch(TARGET, { method: "POST", body: "bytes" });

    expect(res.status).toBe(200);
    // A refresh rotates the CSRF token too, so the replay must re-read it.
    expect(sentTokens).toEqual(["tok-before", "tok-rotated"]);
  });

  it("kicks to login when the refresh reports the session is dead", async () => {
    const kicked = vi.fn();
    setUnauthorizedHandler(kicked);
    const { sentTokens } = stubFetch(
      [new Response(null, { status: 401 })],
      () => new Response(null, { status: 401 }),
    );

    const err = await authedFetch(TARGET).catch((e: unknown) => e);

    // Used to be a silent black hole: no redirect, no prompt, just a failure.
    expect(kicked).toHaveBeenCalledOnce();
    expect(sentTokens).toHaveLength(1);
    expect((err as ApiError).status).toBe(401);
  });

  it("kicks to login when the replay is still refused after a renewal", async () => {
    // The narrow branch that would otherwise reopen the same black hole: a 401
    // ApiError shows no toast (`describeError` returns null on the premise that
    // auth failures redirect), and here nothing was redirecting.
    const kicked = vi.fn();
    setUnauthorizedHandler(kicked);
    const { sentTokens } = stubFetch(
      [
        new Response(null, { status: 401 }),
        new Response(null, { status: 401 }),
      ],
      renewingRefresh("tok-rotated"),
    );

    const err = await authedFetch(TARGET, { method: "POST" }).catch(
      (e: unknown) => e,
    );

    expect(kicked).toHaveBeenCalledOnce();
    expect((err as ApiError).status).toBe(401);
    // Still one replay only — the kick is a notification, not another attempt.
    expect(sentTokens).toEqual([undefined, "tok-rotated"]);
  });

  it("leaves a transient refresh failure a plain error, not session death", async () => {
    const kicked = vi.fn();
    const outage = vi.fn();
    setUnauthorizedHandler(kicked);
    setServiceUnavailableHandler(outage);
    const { sentTokens } = stubFetch(
      [new Response(null, { status: 401 })],
      () => new Response(null, { status: 503 }),
    );

    const err = await authedFetch(TARGET).catch((e: unknown) => e);

    expect(kicked).not.toHaveBeenCalled();
    expect(outage).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(sentTokens).toHaveLength(1);
  });

  it("spends one replay budget across both recoveries", async () => {
    // Refresh renewed, the replay then eats a re-armable CSRF 403 — replaying
    // *that* would be a third attempt, which the shared budget forbids.
    const { sentTokens } = stubFetch(
      [new Response(null, { status: 401 }), csrfRejection("tok-late")],
      renewingRefresh("tok-rotated"),
    );

    const err = await authedFetch(TARGET, { method: "POST" }).catch(
      (e: unknown) => e,
    );

    expect((err as ApiError).status).toBe(403);
    expect(sentTokens).toEqual([undefined, "tok-rotated"]);
  });
});

describe("authedFetch — error surface", () => {
  it("carries the response headers so Retry-After survives", async () => {
    stubFetch([
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    ]);

    const err = await authedFetch(TARGET).catch((e: unknown) => e);

    expect((err as ApiError).retryAfter).toBe(7);
  });

  it("wraps a transport failure as NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await expect(authedFetch(TARGET)).rejects.toBeInstanceOf(NetworkError);
  });

  it("does not drag the app offline on a 5xx", async () => {
    // Intentional asymmetry with `api.request`: one failed file read must not
    // put the whole app on the outage retry screen.
    const outage = vi.fn();
    setServiceUnavailableHandler(outage);
    const { sentTokens } = stubFetch([new Response("boom", { status: 502 })]);

    const err = await authedFetch(TARGET).catch((e: unknown) => e);

    expect(outage).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(sentTokens).toHaveLength(1);
  });
});
