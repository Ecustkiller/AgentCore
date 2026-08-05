// M-01: refresh 成功后重放仍 401 → 清令牌（对齐桌面 replay_still_401）。
// refresh 本身失败路径由 refreshTokens.test.ts 覆盖，本文件不回退其三态语义。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch,
  clearTokens,
  fetchWithAuthRefresh,
  getTokens,
  setTokens,
} from "../client";

const PAIR = { access_token: "old-access", refresh_token: "old-refresh" };
const FRESH = { access_token: "new-access", refresh_token: "new-refresh" };

beforeEach(() => {
  setTokens({ ...PAIR });
});

afterEach(() => {
  clearTokens();
  vi.unstubAllGlobals();
});

describe("fetchWithAuthRefresh / apiFetch (replay still 401)", () => {
  it("clears tokens when refresh succeeds but replay is still 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FRESH), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("still unauthorized", { status: 401 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithAuthRefresh(() =>
      fetch("http://test/v1/resource", {
        headers: { Authorization: `Bearer ${getTokens()?.access_token}` },
      }),
    );

    expect(res.status).toBe(401);
    expect(getTokens()).toBeNull();
    // resource → refresh → resource replay
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps rotated tokens when refresh succeeds and replay is OK", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(FRESH), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiFetch("/v1/resource");

    expect(res.status).toBe(200);
    expect(getTokens()).toMatchObject(FRESH);
  });

  it("does not clear on transient refresh failure (keeps pair for retry)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiFetch("/v1/resource");

    expect(res.status).toBe(401);
    expect(getTokens()).toMatchObject(PAIR);
    expect(fetchMock).toHaveBeenCalledTimes(2); // resource + refresh, no replay
  });

  it("leaves tokens already cleared when refresh itself returns 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiFetch("/v1/resource");

    expect(res.status).toBe(401);
    expect(getTokens()).toBeNull();
  });
});
