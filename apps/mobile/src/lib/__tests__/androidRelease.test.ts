import { afterEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  get: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: capacitorMocks.isNativePlatform,
    getPlatform: () => "web",
  },
  CapacitorHttp: {
    get: capacitorMocks.get,
  },
}));

import {
  fetchLatestAndroidApk,
  parseAndroidLatestManifest,
} from "../androidRelease";

const valid = {
  version: "0.3.24",
  filename: "AgentCore-0.3.24-android.apk",
  downloadUrl:
    "https://github.com/Lawofall/AgentCore-releases/releases/download/android-v0.3.24/AgentCore-0.3.24-android.apk",
};

describe("parseAndroidLatestManifest", () => {
  it("accepts a complete CDN body", () => {
    expect(parseAndroidLatestManifest(valid)).toEqual(valid);
  });

  it("rejects missing fields", () => {
    expect(parseAndroidLatestManifest(null)).toBeNull();
    expect(parseAndroidLatestManifest({})).toBeNull();
    expect(
      parseAndroidLatestManifest({ version: "1.0.0", filename: "x.apk" }),
    ).toBeNull();
  });
});

describe("fetchLatestAndroidApk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    capacitorMocks.isNativePlatform.mockReset();
    capacitorMocks.isNativePlatform.mockReturnValue(false);
    capacitorMocks.get.mockReset();
  });

  it("uses fetch on web and parses JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => valid,
      })),
    );
    await expect(fetchLatestAndroidApk()).resolves.toEqual(valid);
    expect(capacitorMocks.get).not.toHaveBeenCalled();
  });

  it("uses CapacitorHttp on native (CORS bypass)", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.get.mockResolvedValue({ status: 200, data: valid });
    await expect(fetchLatestAndroidApk()).resolves.toEqual(valid);
    expect(capacitorMocks.get).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://downloads.fashitianxia.xyz/android/latest.json",
        responseType: "json",
      }),
    );
  });

  it("fail-opens on network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("CORS blocked");
      }),
    );
    await expect(fetchLatestAndroidApk()).resolves.toBeNull();
  });
});
