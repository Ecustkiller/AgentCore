/**
 * Latest published Android APK from brand CDN
 * (downloads host /android/latest.json). Fail-open on network errors.
 * Native Android uses CapacitorHttp (bypasses WebView CORS); web uses fetch.
 * GitHub AgentCore-releases is archive-only for end users.
 */
import { Capacitor, CapacitorHttp } from "@capacitor/core";

const ANDROID_LATEST_JSON =
  "https://downloads.fashitianxia.xyz/android/latest.json";

export type AndroidApkRelease = {
  version: string;
  downloadUrl: string;
  filename: string;
};

/** Parse CDN `android/latest.json` body; null when required fields missing. */
export function parseAndroidLatestManifest(
  data: unknown,
): AndroidApkRelease | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as {
    version?: string;
    filename?: string;
    downloadUrl?: string;
  };
  const version = String(obj.version ?? "").trim();
  const filename = String(obj.filename ?? "").trim();
  const downloadUrl = String(obj.downloadUrl ?? "").trim();
  if (!version || !filename || !downloadUrl) return null;
  return { version, filename, downloadUrl };
}

async function loadLatestJsonBody(): Promise<unknown | null> {
  // Explicit CapacitorHttp on native — do not enable global fetch patch
  // (avoids auth/cookie surprises on API traffic). Web keeps fetch + CDN CORS.
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url: ANDROID_LATEST_JSON,
      headers: { Accept: "application/json" },
      connectTimeout: 15_000,
      readTimeout: 15_000,
      responseType: "json",
    });
    if (res.status < 200 || res.status >= 300) return null;
    return res.data ?? null;
  }

  const res = await fetch(ANDROID_LATEST_JSON, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Newest Android APK advertised on the download CDN.
 * Fail-open: network / parse errors -> null (no banner).
 */
export async function fetchLatestAndroidApk(): Promise<AndroidApkRelease | null> {
  try {
    const data = await loadLatestJsonBody();
    return parseAndroidLatestManifest(data);
  } catch {
    return null;
  }
}

/** Open the APK download URL in the system browser (sideload, not in-app install). */
export function openApkDownload(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
