import { afterEach, describe, expect, it, vi } from "vitest";
import { tryRefresh } from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tryRefresh single-flight", () => {
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

    expect(await all).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/auth/refresh");
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

  it("reports failure and resets so a later attempt can retry", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await tryRefresh()).toBe(false);
    // Not stuck on the previous (failed) promise — a new round-trip is issued.
    expect(await tryRefresh()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows transport errors as a failed (non-throwing) refresh", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(tryRefresh()).resolves.toBe(false);
  });
});
