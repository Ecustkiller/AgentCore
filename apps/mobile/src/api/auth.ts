// Auth flow for the mobile bearer client (M3). Mirrors the backend /v1/auth/token*
// endpoints added in M2.
import {
  apiFetch,
  apiUrl,
  clearTokens,
  getTokens,
  hydrateTokens,
  setTokens,
} from "@/api/client";
import { disablePush, enablePush } from "@/api/push";

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: string;
  // Carried by /auth/me and the account mutations; optional so the lean login path
  // (token response) doesn't have to populate them. `avatar_url` is a relative path
  // (/v1/users/<id>/avatar?v=…) fetched as a blob for display (bearer can't ride an <img>).
  email?: string | null;
  avatar_url?: string | null;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user?: User;
}

export async function login(username: string, password: string): Promise<User> {
  const res = await fetch(apiUrl("/v1/auth/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "登录失败"));
  }
  const data = (await res.json()) as TokenResponse;
  setTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  // Authenticated → register this device for push (native-only, best-effort, non-blocking).
  void enablePush();
  // The token login returns the user inline (identity in one round trip); fall back
  // to /me only if the server omitted it.
  return data.user ?? (await me());
}

export async function me(): Promise<User> {
  const res = await apiFetch("/v1/auth/me");
  if (!res.ok) throw new Error("未认证");
  return (await res.json()) as User;
}

export async function logout(): Promise<void> {
  const tokens = getTokens();
  if (tokens) {
    // Unregister this device first — the DELETE is bearer-authed, so it must run while the
    // tokens are still present (before clearTokens). Native-only + best-effort.
    await disablePush();
    // Best-effort: revoke the refresh family server-side, but always clear locally.
    await fetch(apiUrl("/v1/auth/token/revoke"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }).catch(() => {});
  }
  clearTokens();
}

export type BootstrapResult =
  | { kind: "authenticated" }
  | { kind: "unauthenticated" }
  | { kind: "unavailable"; reason: string };

// Hand-written: /readyz has no response_model, so the generated type would be an
// untyped dict — this local shape keeps the contract precise (mirrors desktop).
interface ReadinessResponse {
  status: "ready" | "not_ready";
  database: boolean;
}

/**
 * Probe backend readiness via /readyz. Returns null when everything is reachable
 * and healthy, or a user-facing reason when it isn't. Lets the gate show a retry
 * screen (ServiceUnavailablePage) instead of a login form / erroring chat page
 * during an outage. Mirrors the desktop diagnoseOutage (services/auth.ts).
 */
export async function diagnoseOutage(): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("/readyz"));
    const ready = (await res.json()) as ReadinessResponse;
    if (res.ok && ready.database) return null;
    if (!ready.database) return "数据库不可用：请确认数据库已启动后重试。";
    return "后端服务异常：请稍后重试。";
  } catch {
    return "无法连接后端：请确认后端服务已启动后重试。";
  }
}

/**
 * Resolve the initial auth state on app start; routing then renders login/app
 * from the result, while an `unavailable` result drives a retry screen. Mirrors
 * the desktop's bootstrapAuth (services/auth.ts) on the two axes the naive
 * "trust localStorage" check got wrong:
 *   • A stored token pair is NOT proof of a live session — verify before trusting,
 *     else a stale pair passes RequireAuth then 401s and bounces to /login (the
 *     "stuck on login" trap).
 *   • A backend outage is NOT a logout — never clear a valid session (or show a
 *     doomed login form) just because the backend is briefly unreachable.
 *
 * Memoized so React StrictMode's double-invoked startup effect shares one run
 * (the token-presence check would otherwise race two dev logins). Pass force=true
 * to bypass the memo for an explicit retry.
 */
let bootstrapOnce: Promise<BootstrapResult> | null = null;

export function bootstrapAuth(force = false): Promise<BootstrapResult> {
  if (force) bootstrapOnce = null;
  if (!bootstrapOnce) bootstrapOnce = runBootstrap();
  return bootstrapOnce;
}

async function runBootstrap(): Promise<BootstrapResult> {
  // 0. Restore the persisted token pair into the sync cache before any getTokens() —
  //    on native this reads Secure Storage (async), so it must complete before routing.
  await hydrateTokens();
  // 1. Validate any stored session, telling a real logout (401) apart from a
  //    backend outage (5xx / fetch threw). On outage we keep the tokens and route
  //    to the retry screen — a transient outage must never sign a valid session out.
  if (getTokens()) {
    try {
      const res = await apiFetch("/v1/auth/me");
      if (res.ok) {
        void enablePush(); // restored session → (re)register for push (native-only)
        return { kind: "authenticated" };
      }
      if (res.status !== 401) {
        return { kind: "unavailable", reason: await outageReason() };
      }
      clearTokens(); // 401 — stale/revoked, fall through to dev auto-login
    } catch {
      return { kind: "unavailable", reason: await outageReason() }; // transport failure
    }
  }
  // 2. Dev convenience auto-login (no-op in prod / when unconfigured).
  if (await devAutoLogin()) return { kind: "authenticated" };

  // 3. No session. Tell a genuine logged-out state apart from an outage so we
  //    don't show a login form the user could never get past while the backend is
  //    down (dev auto-login also fails during an outage, so diagnose explicitly).
  const reason = await diagnoseOutage();
  return reason ? { kind: "unavailable", reason } : { kind: "unauthenticated" };
}

async function outageReason(): Promise<string> {
  return (await diagnoseOutage()) ?? "后端服务异常：请稍后重试。";
}

/**
 * Dev-only: log in through the real /v1/auth/token flow using credentials from
 * .env.local (VITE_DEV_USERNAME / VITE_DEV_PASSWORD) so you don't retype them on
 * every reload. No-op in production builds (the import.meta.env.DEV guard is
 * statically eliminated) or when the vars are unset. Never bypasses backend auth —
 * it just automates one normal login with a seeded dev user
 * (apps/server/scripts/seed_dev_user.py).
 */
async function devAutoLogin(): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  const username = import.meta.env.VITE_DEV_USERNAME;
  const password = import.meta.env.VITE_DEV_PASSWORD;
  if (!username || !password) return false;
  try {
    await login(username, password);
    return true;
  } catch (err) {
    // Don't swallow it: a silent catch here is exactly what once made a backend
    // outage look like a broken login on desktop. Surface the reason and fall
    // through to the manual login page.
    console.warn("[dev] auto-login failed: check VITE_DEV_* / backend", err);
    return false;
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
