import { ApiError, BASE_URL, NetworkError, api } from "@/services/api";
import type { AuthUser } from "@/stores/auth";

interface BackendUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  created_at: string;
}

function toUser(u: BackendUser): AuthUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    email: u.email,
    role: u.role,
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
  return toUser(
    await api.post<BackendUser>("/v1/auth/login", { username, password }),
  );
}

export interface RegisterInput {
  username: string;
  password: string;
  inviteCode: string;
  displayName?: string;
}

export async function register(input: RegisterInput): Promise<AuthUser> {
  return toUser(
    await api.post<BackendUser>("/v1/auth/register", {
      username: input.username,
      password: input.password,
      invite_code: input.inviteCode,
      display_name: input.displayName || undefined,
    }),
  );
}

export async function logout(): Promise<void> {
  await api.post("/v1/auth/logout");
}

/**
 * A transport failure or a 5xx — i.e. the backend is down or broken — as opposed
 * to a 401 that merely means "not logged in". This split is what lets the app
 * show a retry screen instead of a login form during an outage.
 */
function isOutage(err: unknown): boolean {
  return (
    err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)
  );
}

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
