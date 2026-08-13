/**
 * Renderer-side device identity for the fulfill channel (`device_id`).
 *
 * Durable id lives in Electron userData via main-process IPC. Web / preview
 * runtimes have no fulfiller role — callers should skip the stream entirely.
 *
 * The id is also sent on every request as `X-Client-Device` so the server can
 * run CLIENT_TOOL ops on the machine that asked for them (see the server's
 * `fulfill/origin.py`). Request headers are built synchronously, hence the
 * module-level cache below: it is filled once the async IPC resolves, and until
 * then the header is simply omitted (server falls back to picking any device).
 */

let cached: string | null = null;

/** Resolve the install-stable device_id (creates + persists on first use). */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  const api = window.deviceIdentityApi;
  if (!api?.getDeviceId) {
    throw new Error("deviceIdentityApi unavailable (Electron only)");
  }
  const id = await api.getDeviceId();
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("deviceIdentityApi returned empty device_id");
  }
  cached = id.trim();
  return cached;
}

/** The resolved device_id, or null before the first {@link getDeviceId}. */
export function cachedDeviceId(): string | null {
  return cached;
}

/** Warm the cache so request headers carry the device id from the first turn. */
export function primeDeviceId(): void {
  void getDeviceId().catch(() => {
    /* web / missing preload — headers stay without the device id */
  });
}

/** Test-only: drop the cached id between cases. */
export function resetDeviceIdentityForTests(): void {
  cached = null;
}
