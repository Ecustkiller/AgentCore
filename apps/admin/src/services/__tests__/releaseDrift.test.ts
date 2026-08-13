import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELEASE_DRIFT_FETCH_TIMEOUT_MS,
  buildShasMatch,
  fetchReleaseDrift,
  releaseProbeConfig,
  versionsMatch,
} from "../releaseDrift";

const CDN_URL = "https://cdn.example.test/desktop/latest.json";
const DOWNLOAD_URL = "https://example.test/api/desktop-release";

function configureProbe(): void {
  vi.stubEnv("VITE_RELEASE_CDN_LATEST_URL", CDN_URL);
  vi.stubEnv("VITE_RELEASE_DOWNLOAD_API_URL", DOWNLOAD_URL);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("releaseProbeConfig", () => {
  it("stays off when the brand release URLs are not injected at build time", () => {
    expect(releaseProbeConfig()).toBeNull();
  });

  it("stays off when only one endpoint is configured (nothing to compare)", () => {
    vi.stubEnv("VITE_RELEASE_CDN_LATEST_URL", CDN_URL);

    expect(releaseProbeConfig()).toBeNull();
  });

  it("reads both endpoints from the build env", () => {
    configureProbe();

    expect(releaseProbeConfig()).toEqual({
      cdnLatestUrl: CDN_URL,
      downloadApiUrl: DOWNLOAD_URL,
    });
  });
});

describe("fetchReleaseDrift", () => {
  it("issues no cross-origin request when the probe is unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchReleaseDrift()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes AbortSignal.timeout(~8s) on each configured fetch", async () => {
    configureProbe();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snap = await fetchReleaseDrift();

    expect(snap).toEqual({
      desktopCdnVersion: "1.2.3",
      websiteDownloadVersion: "1.2.3",
      unreachable: [],
    });
    expect(timeoutSpy).toHaveBeenCalledWith(RELEASE_DRIFT_FETCH_TIMEOUT_MS);
    expect(RELEASE_DRIFT_FETCH_TIMEOUT_MS).toBe(8_000);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      CDN_URL,
      DOWNLOAD_URL,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("records abort / network failures as unreachable without throwing", async () => {
    configureProbe();
    const fetchMock = vi.fn(() =>
      Promise.reject(new DOMException("The operation was aborted", "TimeoutError")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snap = await fetchReleaseDrift();

    expect(snap?.desktopCdnVersion).toBeNull();
    expect(snap?.websiteDownloadVersion).toBeNull();
    expect(snap?.unreachable).toHaveLength(2);
    expect(snap?.unreachable[0]).toContain("下载 CDN");
    expect(snap?.unreachable[1]).toContain("下载页 API");
  });
});

describe("versionsMatch", () => {
  it("returns null while either side is unknown", () => {
    expect(versionsMatch(null, "1.2.3")).toBeNull();
    expect(versionsMatch("1.2.3", null)).toBeNull();
  });

  it("compares two known versions", () => {
    expect(versionsMatch("1.2.3", "1.2.3")).toBe(true);
    expect(versionsMatch("1.2.3", "1.2.4")).toBe(false);
  });
});

describe("buildShasMatch", () => {
  // 后端 config.git_sha 默认 "unknown"，前端未注入构建信息时 clientGitSha() 同值 —— 这
  // 是「信息未知」，把它算成异轨会让所有本地 / 自建部署常年亮黄。
  it("treats the `unknown` placeholder as unknown, not as drift", () => {
    expect(buildShasMatch("unknown", "9f2c1ab")).toBeNull();
    expect(buildShasMatch("9f2c1ab", "unknown")).toBeNull();
    expect(buildShasMatch("unknown", "unknown")).toBeNull();
    expect(buildShasMatch("UNKNOWN", "9f2c1ab")).toBeNull();
  });

  it("treats a missing / blank sha as unknown", () => {
    expect(buildShasMatch(null, "9f2c1ab")).toBeNull();
    expect(buildShasMatch(undefined, "9f2c1ab")).toBeNull();
    expect(buildShasMatch("", "9f2c1ab")).toBeNull();
    expect(buildShasMatch("   ", "9f2c1ab")).toBeNull();
  });

  it("reports real drift between two known shas", () => {
    expect(buildShasMatch("9f2c1ab", "3d81f04")).toBe(false);
    expect(
      buildShasMatch(
        "9f2c1ab",
        "3d81f0442c6f1b0d9e8a77c5b3e21f4a6d0c9b8e",
      ),
    ).toBe(false);
  });

  it("matches a short sha against the full one from the other side", () => {
    expect(
      buildShasMatch(
        "9f2c1ab",
        "9f2c1ab42c6f1b0d9e8a77c5b3e21f4a6d0c9b8e",
      ),
    ).toBe(true);
    expect(
      buildShasMatch(
        "9F2C1AB42C6F1B0D9E8A77C5B3E21F4A6D0C9B8E",
        "9f2c1ab",
      ),
    ).toBe(true);
  });
});
