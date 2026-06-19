// Self-service account management for the mobile client (设置·账户设置).
//
// Profile / password / avatar / 注销 over the same endpoints the desktop uses
// (auth.ts + users.py). Returns the refreshed User so callers can re-render. The
// avatar is fetched as a blob → object URL (a bearer token can't ride an <img src>,
// unlike the desktop's cookie auth), so display works under Authorization headers.
import { apiFetch } from "@/api/client";
import type { User } from "@/api/auth";

/** Mirror of the server's avatar_upload_max_bytes so an oversized pick fails fast. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

async function readUser(res: Response, fallback: string): Promise<User> {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return (await res.json()) as User;
}

/** Edit display name and/or email (PATCH semantics: omitted keys stay, `email:""`
 *  clears it). Returns the refreshed user. 422 if the email is taken. */
export async function updateProfile(update: {
  display_name?: string;
  email?: string | null;
}): Promise<User> {
  const res = await apiFetch("/v1/auth/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return readUser(res, "保存失败");
}

/** Change password; the backend keeps THIS device signed in and revokes the others. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const res = await apiFetch("/v1/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "修改失败"));
}

/** Upload a new avatar: the backend reads the RAW image bytes (no multipart) and
 *  re-encodes to a square WebP, so we send the File directly with its mime type. */
export async function uploadAvatar(file: File): Promise<User> {
  const res = await apiFetch("/v1/users/me/avatar", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  return readUser(res, "上传失败");
}

/** Remove the avatar and fall back to the initial. Returns the refreshed user. */
export async function deleteAvatar(): Promise<User> {
  return readUser(await apiFetch("/v1/users/me/avatar", { method: "DELETE" }), "操作失败");
}

/** Self-service 注销: soft-delete + anonymize behind a password re-confirm. The caller
 *  must drop to login afterwards (the session is revoked server-side). */
export async function deleteAccount(password: string): Promise<void> {
  const res = await apiFetch("/v1/auth/me", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "注销失败"));
}

/** Fetch an avatar (relative path from `user.avatar_url`) as an object URL — the only
 *  way to show it under bearer auth. Returns null on failure (UI falls back to the
 *  initial). The caller must `URL.revokeObjectURL` it on unmount / change. */
export async function fetchAvatarObjectUrl(
  avatarUrl: string,
): Promise<string | null> {
  try {
    const res = await apiFetch(avatarUrl);
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}
