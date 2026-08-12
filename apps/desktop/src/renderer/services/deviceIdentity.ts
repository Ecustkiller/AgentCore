/**
 * Renderer-side device identity for the fulfill channel (`device_id`).
 *
 * Durable id lives in Electron userData via main-process IPC. Web / preview
 * runtimes have no fulfiller role — callers should skip the stream entirely.
 */

/** Resolve the install-stable device_id (creates + persists on first use). */
export async function getDeviceId(): Promise<string> {
  const api = window.deviceIdentityApi;
  if (!api?.getDeviceId) {
    throw new Error("deviceIdentityApi unavailable (Electron only)");
  }
  const id = await api.getDeviceId();
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("deviceIdentityApi returned empty device_id");
  }
  return id.trim();
}
