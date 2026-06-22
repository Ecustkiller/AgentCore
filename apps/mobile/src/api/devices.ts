// Push device registration REST for the mobile client (原生推送设备注册, 前端技术与架构 §七).
//
// Thin bearer-authenticated wrappers over the backend device endpoints
// (api/routes/devices.py). Pure REST — the native FCM token lifecycle (permission, OS
// register, tap → deep-link) lives in push.ts; this file just maps a token to the user.
import { apiFetch } from "@/api/client";

/** The platforms the backend accepts (schemas.py DeviceRegistration): a closed set so a
 *  bad client can't seed an unroutable row. Maps 1:1 to Capacitor.getPlatform(). */
export type DevicePlatform = "ios" | "android" | "web";

/** Register (or refresh) this device's push token for the current user. Idempotent upsert
 *  server-side — re-registering after a token rotation / new login just moves the token to
 *  the current user, so calling this on every authenticated launch is safe. */
export async function registerDevice(
  token: string,
  platform: DevicePlatform,
): Promise<void> {
  const res = await apiFetch("/v1/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, platform }),
  });
  if (!res.ok) throw new Error(`设备注册失败 (${res.status})`);
}

/** Unregister one device token (logout). `token` is a query param — an FCM token contains
 *  URL-reserved characters, so a path segment is unsafe. Owner-scoped + idempotent
 *  server-side (deleting an unknown token still succeeds). */
export async function unregisterDevice(token: string): Promise<void> {
  const res = await apiFetch(`/v1/devices?token=${encodeURIComponent(token)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`设备注销失败 (${res.status})`);
}
