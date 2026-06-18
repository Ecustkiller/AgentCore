// Bearer-token API client for the mobile web/Capacitor shell (手机端落地设计 P0/M3).
//
// Unlike desktop (httpOnly cookies over the app:// origin), the mobile origin
// (capacitor:// / a new web origin) can't rely on SameSite cookies, so the client
// holds the token pair and sends `Authorization: Bearer <access>` on every call
// (backend resolution: api/dependencies.py get_current_user).
//
// SKELETON NOTE: tokens live in localStorage for now (XSS-exposed). M2/P2 swaps this
// for Capacitor Secure Storage; the access TTL + refresh rotation already bound the blast.

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

const ACCESS_KEY = "agentcore.mobile.access";
const REFRESH_KEY = "agentcore.mobile.refresh";

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

export function getTokens(): Tokens | null {
  const access_token = localStorage.getItem(ACCESS_KEY);
  const refresh_token = localStorage.getItem(REFRESH_KEY);
  return access_token && refresh_token ? { access_token, refresh_token } : null;
}

export function setTokens(tokens: Tokens): void {
  localStorage.setItem(ACCESS_KEY, tokens.access_token);
  localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function apiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

export function authHeader(): Record<string, string> {
  const tokens = getTokens();
  return tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {};
}

/** Rotate the token pair via the bearer refresh endpoint. Returns true on success;
 *  clears tokens on failure so the caller can route back to login. */
export async function refreshTokens(): Promise<boolean> {
  const tokens = getTokens();
  if (!tokens) return false;
  const res = await fetch(apiUrl("/v1/auth/token/refresh"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: tokens.refresh_token }),
  });
  if (!res.ok) {
    clearTokens();
    return false;
  }
  const data = (await res.json()) as Tokens;
  setTokens(data);
  return true;
}

/**
 * Bearer-authenticated fetch for JSON endpoints. On 401 it refreshes once and
 * replays; a still-401 leaves tokens cleared so the caller routes back to login.
 * The SSE stream reads the body itself and mirrors this policy (see stream.ts).
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const run = () =>
    fetch(apiUrl(path), {
      ...init,
      headers: { ...(init.headers ?? {}), ...authHeader() },
    });
  let res = await run();
  if (res.status === 401 && (await refreshTokens())) {
    res = await run();
  }
  return res;
}
