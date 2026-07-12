/**
 * Main-process first-class API client (as-built: 认证与会话 §七 / §五).
 *
 * Pure Bearer: reads access_token from the session cookie jar, sends
 * `Authorization: Bearer …` and **never** attaches Cookie headers (CSRF exempt
 * only when Bearer is present AND no access_token cookie — middleware/csrf.py).
 *
 * Refresh: `POST /v1/auth/token/refresh` (body) → write new tokens back into
 * cookies so the renderer stays in sync. Single-flight across writeback +
 * renderer IPC so refresh-family rotation never double-fires.
 */
import type { components } from "@agentcore/contract-rest-types";
import { net, session } from "electron";
import type { AuthRefreshResult } from "../shared/outbox-contract";

type TokenResponse = components["schemas"]["TokenResponse"];

const ACCESS_COOKIE = "access_token";
const REFRESH_COOKIE = "refresh_token";
/** Fallback when bearer TokenResponse omits `refresh_expires_in` (older servers). */
const DEFAULT_REFRESH_EXPIRES_SEC = 30 * 86400;

declare const __API_BASE_URL__: string;

/** Full API base including path prefix (e.g. `https://host/api` or `http://localhost:8000`). */
export function apiBase(): string {
  try {
    return String(__API_BASE_URL__).replace(/\/$/, "");
  } catch {
    return "http://localhost:8000";
  }
}

export function apiOrigin(): string {
  try {
    return new URL(apiBase()).origin;
  } catch {
    return "http://localhost:8000";
  }
}

/** Path prefix baked into the API base (e.g. `/api` in prod; empty in local dev). */
export function apiPathPrefix(): string {
  try {
    const path = new URL(apiBase()).pathname.replace(/\/$/, "");
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
}

/**
 * Derive cookie SameSite/Secure from the API URL.
 * https → None+Secure (prod cross-site); http → Lax+insecure (dev localhost).
 */
export function deriveAuthCookieAttrs(cookieUrl: string): {
  secure: boolean;
  sameSite: "lax" | "no_restriction";
} {
  const secure = cookieUrl.startsWith("https:");
  return {
    secure,
    sameSite: secure ? "no_restriction" : "lax",
  };
}

function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${apiBase()}${p}`;
}

async function readAuthCookies(): Promise<{
  access_token?: string;
  refresh_token?: string;
}> {
  const all = await session.defaultSession.cookies.get({});
  const access = all.find((c) => c.name === ACCESS_COOKIE)?.value;
  const refresh = all.find((c) => c.name === REFRESH_COOKIE)?.value;
  return { access_token: access, refresh_token: refresh };
}

function cookieUrl(): string {
  // Cookie URL must match the API origin so Chromium stores them for that host.
  return apiOrigin();
}

function refreshCookiePath(): string {
  // Mirror server `_refresh_cookie_path`: path-scoped to auth refresh endpoints.
  const prefix = apiPathPrefix();
  return `${prefix}/v1/auth`;
}

async function writeAuthCookies(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  refresh_expires_in?: number;
}): Promise<void> {
  const url = cookieUrl();
  const { secure, sameSite } = deriveAuthCookieAttrs(url);
  const nowSec = Math.floor(Date.now() / 1000);
  const accessExpiry =
    typeof tokens.expires_in === "number"
      ? nowSec + tokens.expires_in
      : undefined;
  const refreshExpiry =
    nowSec + (tokens.refresh_expires_in ?? DEFAULT_REFRESH_EXPIRES_SEC);
  await session.defaultSession.cookies.set({
    url,
    name: ACCESS_COOKIE,
    value: tokens.access_token,
    path: "/",
    httpOnly: true,
    secure,
    sameSite,
    expirationDate: accessExpiry,
  });
  await session.defaultSession.cookies.set({
    url,
    name: REFRESH_COOKIE,
    value: tokens.refresh_token,
    path: refreshCookiePath(),
    httpOnly: true,
    secure,
    sameSite,
    expirationDate: refreshExpiry,
  });
}

let refreshInFlight: Promise<AuthRefreshResult> | null = null;

/**
 * Rotate tokens via body refresh; single-flight for main + renderer callers.
 * Three-state so transient outages are never mistaken for session death.
 */
export function refreshAccessToken(): Promise<AuthRefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async (): Promise<AuthRefreshResult> => {
    const cookies = await readAuthCookies();
    const refresh = cookies.refresh_token?.trim();
    if (!refresh) return "auth_dead";
    let res: Response;
    try {
      // `credentials: "omit"` is REQUIRED (not cosmetic): a main-process net.fetch has
      // no document origin, so Electron coerces the default `same-origin` credentials to
      // `include` (electron/lib/browser/api/net-fetch.ts) and would attach defaultSession
      // cookies. This must stay a pure Bearer client — refresh travels in the body only.
      res = await net.fetch(apiUrl("/v1/auth/token/refresh"), {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      });
    } catch {
      return "transient";
    }
    if (res.status === 401 || res.status === 403) return "auth_dead";
    if (!res.ok) return "transient";
    let body: TokenResponse;
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      return "transient";
    }
    if (!body.access_token || !body.refresh_token) return "transient";
    try {
      await writeAuthCookies({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_in: body.expires_in,
        refresh_expires_in: body.refresh_expires_in ?? undefined,
      });
    } catch {
      // Server already rotated; local jar write failed — retry later, don't logout.
      return "transient";
    }
    return "renewed";
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export interface BearerJsonResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * POST JSON with pure Bearer auth (no Cookie header). On 401, refresh once and retry.
 */
export async function bearerPostJson(
  path: string,
  body: unknown,
): Promise<BearerJsonResult> {
  // `credentials: "omit"` is REQUIRED, not cosmetic: a main-process net.fetch has no
  // document origin, so Electron coerces the default `same-origin` credentials to
  // `include` (electron/lib/browser/api/net-fetch.ts) and would attach the defaultSession
  // `access_token` cookie. That cookie breaks the server's pure-Bearer CSRF exemption
  // (middleware/csrf.py: exempt only when Bearer present AND no access_token cookie) →
  // a 403 on every write-back. Omit keeps this a true cookie-less Bearer client.
  const doFetch = async (access: string): Promise<Response> =>
    net.fetch(apiUrl(path), {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access}`,
      },
      body: JSON.stringify(body),
    });

  const cookies = await readAuthCookies();
  let access = cookies.access_token?.trim();
  if (!access) {
    const refreshed = await refreshAccessToken();
    if (refreshed !== "renewed") {
      return { ok: false, status: 401, body: { error: "missing_token" } };
    }
    access = (await readAuthCookies()).access_token?.trim();
    if (!access) {
      return { ok: false, status: 401, body: { error: "missing_token" } };
    }
  }

  let res = await doFetch(access);
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed === "renewed") {
      access = (await readAuthCookies()).access_token?.trim();
      if (access) res = await doFetch(access);
    }
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** Test seam: clear in-flight refresh. */
export function resetAuthClientForTests(): void {
  refreshInFlight = null;
}
