/**
 * Logout's local cleanup. Production logs showed the console's only CSRF 403s all
 * landing on `/v1/auth/logout`: the token was cleared *after* the awaited call, so a
 * logout that failed left it behind, and every later mutating request — including the
 * next logout attempt — was rejected with it. The operator ends up unable to sign out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, api, clearCsrfToken } from "../api";
import { logout } from "../auth";

interface Sent {
  url: string;
  init: RequestInit;
}

function stubFetch(respond: (nth: number) => Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      sent.push({ url, init });
      return respond(sent.length - 1);
    }),
  );
  return sent;
}

/** Headers of the nth call; asserts the call happened so a missing request cannot
 *  masquerade as "no CSRF header was sent". */
function headersOf(sent: Sent[], index: number): Record<string, string> {
  const call = sent[index];
  expect(call, `expected a request #${index}, got ${sent.length}`).toBeDefined();
  return (call?.init.headers ?? {}) as Record<string, string>;
}

function jsonOk(csrf?: string): Response {
  return new Response("{}", {
    status: 200,
    headers: csrf ? { "X-CSRF-Token": csrf } : {},
  });
}

function csrfRejection(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "CSRF_FAILED",
        message: "CSRF token missing or invalid. Re-login and retry.",
      },
    }),
    { status: 403 },
  );
}

beforeEach(() => {
  clearCsrfToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("logout", () => {
  it("drops the CSRF token on a successful logout", async () => {
    const sent = stubFetch((nth) => Promise.resolve(jsonOk(nth === 0 ? "t1" : undefined)));
    await api.get("/v1/admin/users"); // seed

    await logout();
    await api.post("/v1/admin/notices", {});

    expect(headersOf(sent, 1)["X-CSRF-Token"]).toBe("t1"); // the logout itself
    expect(headersOf(sent, 2)["X-CSRF-Token"]).toBeUndefined();
  });

  it("drops it even when the server rejects the logout, and still surfaces the error", async () => {
    const sent = stubFetch((nth) =>
      Promise.resolve(nth === 1 ? csrfRejection() : jsonOk(nth === 0 ? "t1" : undefined)),
    );
    await api.get("/v1/admin/users"); // seed

    await expect(logout()).rejects.toBeInstanceOf(ApiError);
    await api.post("/v1/admin/notices", {});

    expect(sent[1]?.url).toContain("/v1/auth/logout");
    expect(headersOf(sent, 2)["X-CSRF-Token"]).toBeUndefined();
  });

  it("drops it when the logout never reaches the server", async () => {
    const sent = stubFetch((nth) =>
      nth === 1
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(jsonOk(nth === 0 ? "t1" : undefined)),
    );
    await api.get("/v1/admin/users"); // seed

    await expect(logout()).rejects.toBeInstanceOf(NetworkError);
    await api.post("/v1/admin/notices", {});

    expect(headersOf(sent, 2)["X-CSRF-Token"]).toBeUndefined();
  });
});
