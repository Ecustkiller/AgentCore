import {
  ApiError,
  BASE_URL,
  NetworkError,
  api,
  tryRefresh,
} from "@/services/api";
import { clearSidecarInference } from "@/services/inferenceToken";
import type { AuthUser } from "@/stores/auth";
import type { components } from "@/types/api.generated";

/** Server user payload (`/auth/me|login|register`), generated from OpenAPI. */
type BackendUser = components["schemas"]["UserResponse"];

/** Resolve the backend's relative avatar URL (`/v1/users/<id>/avatar?v=…`) against
 *  the API base so consumers can drop it straight into an `<img src>`. Leaves
 *  absolute URLs untouched; null stays null (UI falls back to the initial). */
function avatarSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("/") ? `${BASE_URL}${url}` : url;
}

function toUser(u: BackendUser): AuthUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
    defaultModelMode: u.default_model_mode ?? null,
    avatarUrl: avatarSrc(u.avatar_url),
  };
}

/** Resolve the current session from the access cookie (throws 401 if absent). */
export async function fetchMe(): Promise<AuthUser> {
  return toUser(await api.get<BackendUser>("/v1/auth/me"));
}

export async function login(
  username: string,
  password: string,
): Promise<AuthUser> {
  const user = toUser(
    await api.post<BackendUser>("/v1/auth/login", { username, password }),
  );
  // Fresh session → drop any inference token cached for a previous user, so the
  // sidecar never mints under one user then bills another (token is user-scoped).
  clearSidecarInference();
  return user;
}

export interface RegisterInput {
  username: string;
  password: string;
  inviteCode: string;
  displayName?: string;
}

export async function register(input: RegisterInput): Promise<AuthUser> {
  const user = toUser(
    await api.post<BackendUser>("/v1/auth/register", {
      username: input.username,
      password: input.password,
      invite_code: input.inviteCode,
      display_name: input.displayName || undefined,
    }),
  );
  clearSidecarInference(); // fresh session → drop any prior-user token (see login)
  return user;
}

export async function logout(): Promise<void> {
  await api.post("/v1/auth/logout");
  clearSidecarInference(); // session ended → next login re-mints
}

/**
 * Change the signed-in user's password (修改密码). The backend revokes every other
 * device's session and re-issues this one's cookies, so the caller stays logged in
 * — no re-login needed here. Throws {@link ApiError} (401 wrong current password,
 * 422 weak/unchanged new password) for the form to surface.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await api.post("/v1/auth/change-password", {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

/** Profile fields the user may edit. Omit a key to leave it unchanged; pass
 *  `email: null` to clear it (PATCH semantics, mirrored on the backend). */
export interface ProfileUpdate {
  displayName?: string;
  email?: string | null;
}

/** Update the signed-in user's profile (个人资料编辑); returns the refreshed user so
 *  the caller can sync the auth store. 422 if the email is already taken. */
export async function updateProfile(update: ProfileUpdate): Promise<AuthUser> {
  const body: Record<string, unknown> = {};
  if (update.displayName !== undefined) body.display_name = update.displayName;
  if (update.email !== undefined) body.email = update.email;
  return toUser(await api.patch<BackendUser>("/v1/auth/me", body));
}

/**
 * Upload a new avatar (头像上传). The backend reads the **raw image bytes** (no
 * multipart) and re-encodes them to a square WebP, so we POST the File directly —
 * the shared `api` helper can't be used as it JSON-encodes the body. Returns the
 * refreshed user (its `avatarUrl` carries a content-hash cache-buster, so the new
 * picture shows immediately). Mirrors `api.ts`'s refresh-once-on-401 policy.
 */
export async function uploadAvatar(file: File): Promise<AuthUser> {
  const send = (): Promise<Response> =>
    fetch(`${BASE_URL}/v1/users/me/avatar`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && (await tryRefresh())) res = await send();
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!res.ok) throw new ApiError(res.status, await res.text(), res.headers);
  return toUser((await res.json()) as BackendUser);
}

/** Remove the avatar and fall back to the initial (恢复默认头像). Idempotent on the
 *  backend; returns the refreshed user with `avatarUrl: null`. */
export async function deleteAvatar(): Promise<AuthUser> {
  return toUser(await api.delete<BackendUser>("/v1/users/me/avatar"));
}

/**
 * Self-service account deletion (注销账户). The password re-confirms intent; the
 * backend soft-deletes + anonymizes the account and revokes all sessions. The
 * caller must drop to the login screen afterwards. Throws {@link ApiError} (401
 * wrong password) for the form to surface.
 */
export async function deleteAccount(password: string): Promise<void> {
  await api.delete("/v1/auth/me", { password });
  clearSidecarInference(); // account gone → drop any cached inference token
}

/**
 * A transport failure or a 5xx — i.e. the backend is down or broken — as opposed
 * to a 401 that merely means "not logged in". This split is what lets the app
 * show a retry screen instead of a login form during an outage.
 */
function isOutage(err: unknown): boolean {
  return (
    err instanceof NetworkError ||
    (err instanceof ApiError && err.status >= 500)
  );
}

// Hand-written on purpose: `/readyz` has no response_model, so the generated
// type is an untyped dict — this local shape stays the precise contract.
interface ReadinessResponse {
  status: "ready" | "not_ready";
  database: boolean;
}

/**
 * Probe backend readiness via `/readyz`. Returns null when everything is
 * reachable, or a user-facing reason when it isn't. Uses raw fetch so the 503
 * body (which `api.get` would raise as an ApiError) stays readable.
 *
 * Exported so the gate can reuse the exact same diagnosis to confirm a
 * mid-session outage before taking over the screen.
 */
export async function diagnoseOutage(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/readyz`, { credentials: "include" });
    const ready = (await res.json()) as ReadinessResponse;
    if (res.ok && ready.database) return null;
    if (!ready.database) return "数据库不可用：请确认数据库已启动后重试。";
    return "后端服务异常：请稍后重试。";
  } catch {
    return "无法连接后端：请确认后端服务已启动后重试。";
  }
}

type DevLoginResult =
  | { kind: "ok"; user: AuthUser }
  | { kind: "skipped" }
  | { kind: "unavailable" }
  | { kind: "failed" };

/**
 * Dev-only convenience: log in through the real `/auth/login` flow using
 * credentials from `.env.local` (VITE_DEV_USERNAME / VITE_DEV_PASSWORD) so you
 * don't retype them on every restart. No-op in production builds (the
 * `import.meta.env.DEV` guard is statically eliminated) or when vars are unset.
 *
 * This never bypasses the backend auth check — it just automates a normal login
 * with a seeded dev user. Unlike a bare null, the result tells an outage apart
 * from bad credentials and (in dev) logs the real reason instead of swallowing
 * it: a silent catch here is exactly what made a DB outage look like a broken
 * login feature.
 */
async function devAutoLogin(): Promise<DevLoginResult> {
  if (!import.meta.env.DEV) return { kind: "skipped" };
  const username = import.meta.env.VITE_DEV_USERNAME;
  const password = import.meta.env.VITE_DEV_PASSWORD;
  if (!username || !password) return { kind: "skipped" };
  try {
    return { kind: "ok", user: await login(username, password) };
  } catch (err) {
    if (isOutage(err)) {
      console.warn("[dev] auto-login skipped: backend unavailable", err);
      return { kind: "unavailable" };
    }
    console.warn("[dev] auto-login failed: check VITE_DEV_* credentials", err);
    return { kind: "failed" };
  }
}

export type BootstrapResult =
  | { kind: "authenticated"; user: AuthUser }
  | { kind: "unauthenticated" }
  | { kind: "unavailable"; reason: string };

/**
 * Resolve the initial auth state on app start. Critically, it tells an
 * infrastructure outage apart from "not logged in" so the gate can show a retry
 * screen rather than a login form the user could never get past.
 */
export async function bootstrapAuth(): Promise<BootstrapResult> {
  // 1. Existing session via the access cookie.
  try {
    return { kind: "authenticated", user: await fetchMe() };
  } catch (err) {
    if (isOutage(err)) {
      const reason = (await diagnoseOutage()) ?? "后端服务异常：请稍后重试。";
      return { kind: "unavailable", reason };
    }
    // 401 → no valid session; fall through to dev auto-login.
  }

  // 2. Dev convenience auto-login (no-op in prod / when unconfigured).
  const dev = await devAutoLogin();
  if (dev.kind === "ok") return { kind: "authenticated", user: dev.user };

  // 3. No session. If the backend is actually unreachable, surface that instead
  //    of a doomed login form; otherwise it's a genuine logged-out state.
  const reason = await diagnoseOutage();
  return reason ? { kind: "unavailable", reason } : { kind: "unauthenticated" };
}
