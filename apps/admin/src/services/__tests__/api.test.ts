import { afterEach, describe, expect, it, vi } from "vitest";
import { tryRefresh } from "../api";

afterEach(() => {
  vi.unstubAllGlobals();
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
