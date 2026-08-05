import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELEASE_DRIFT_FETCH_TIMEOUT_MS,
  fetchReleaseDrift,
} from "../releaseDrift";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchReleaseDrift", () => {
  it("passes AbortSignal.timeout(~8s) on each external fetch", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchReleaseDrift();

    expect(timeoutSpy).toHaveBeenCalledWith(RELEASE_DRIFT_FETCH_TIMEOUT_MS);
    expect(RELEASE_DRIFT_FETCH_TIMEOUT_MS).toBe(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("records abort / network failures in errors without throwing", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new DOMException("The operation was aborted", "TimeoutError")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snap = await fetchReleaseDrift();

    expect(snap.desktopCdnVersion).toBeNull();
    expect(snap.websiteDownloadVersion).toBeNull();
    expect(snap.errors).toHaveLength(2);
    expect(snap.errors[0]).toContain("下载 CDN");
    expect(snap.errors[1]).toContain("下载页 API");
  });
});
