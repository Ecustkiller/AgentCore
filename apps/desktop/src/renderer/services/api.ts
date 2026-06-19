export const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  /** Backend error code from the `{error:{code,message}}` contract (main.py's
   * global handler over the AgentCoreError hierarchy), when the body parses. Lets
   * callers branch on the cause without string-matching the message. */
  readonly code?: string;
  /** The backend's user-facing message from the same contract — often a ready-to
   * -show zh string. Distinct from {@link body}, which is the raw (possibly
   * non-JSON) response text kept for logging. */
  readonly serverMessage?: string;
  /** Seconds to wait before retrying, from a `Retry-After` header (e.g. 429s). */
  readonly retryAfter?: number;

  constructor(
    public status: number,
    public body: string,
    headers?: Headers,
  ) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
    // Every backend error is `{error:{code,message}}`; parse it so the shared
    // error map (lib/errors) can phrase REST failures the same way it phrases
    // SSE-turn failures. A non-JSON body (e.g. a proxy error page) just leaves
    // code/serverMessage undefined and callers fall back to status phrasing.
    try {
      const parsed = JSON.parse(body) as {
        error?: { code?: string; message?: string };
      };
      this.code = parsed.error?.code;
      this.serverMessage = parsed.error?.message;
    } catch {
      /* non-JSON body — keep the raw text only */
    }
    const ra = Number(headers?.get("Retry-After"));
    this.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : undefined;
  }
}

/**
 * The request never completed at the transport layer (server unreachable, DNS
 * failure, offline, blocked CORS preflight). Distinct from {@link ApiError},
 * which means the server *did* respond, just with a non-2xx status. Callers use
 * this split to tell a backend outage apart from a 401/4xx.
 */
export class NetworkError extends Error {
  constructor(public readonly detail?: unknown) {
    super("network request failed");
    this.name = "NetworkError";
  }
}

// Invoked when a request stays unauthorized even after a refresh attempt, so the
// app can drop to the login screen. Registered by the auth gate to avoid a
// store import cycle (the auth store must not depend on this module).
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** Drop to the login screen via the registered handler (no-op if unset). */
export function notifyUnauthorized(): void {
  onUnauthorized?.();
}

// Invoked when a request looks like a backend outage (transport failure or 5xx)
// so the app can confirm via /readyz and switch to a retry screen mid-session,
// the same way it does on startup. Registered by the auth gate.
let onServiceUnavailable: (() => void) | null = null;

export function setServiceUnavailableHandler(
  handler: (() => void) | null,
): void {
  onServiceUnavailable = handler;
}

const isAuthPath = (path: string): boolean => path.startsWith("/v1/auth/");

/**
 * Attempt a single token refresh; returns true if the session was renewed.
 *
 * Exported so non-`api` callers (e.g. the raw-fetch SSE stream) can reuse the
 * exact same refresh-once policy instead of reimplementing it.
 */
export async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = false,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });
  } catch (cause) {
    // fetch only rejects on transport failure (the server never answered), so
    // surface a typed NetworkError the bootstrap can treat as an outage.
    if (!isAuthPath(path)) onServiceUnavailable?.();
    throw new NetworkError(cause);
  }

  if (response.ok) {
    return response.json();
  }

  // Access token likely expired: refresh once and replay, then give up to the
  // login screen. Auth endpoints opt out so login failures and the refresh call
  // itself never recurse.
  if (response.status === 401 && !isAuthPath(path)) {
    if (!retry && (await tryRefresh())) {
      return request<T>(path, options, true);
    }
    onUnauthorized?.();
  }

  // A 5xx means the server is reachable but broken; flag a possible outage so
  // the gate can confirm via /readyz and drop to the retry screen. Auth paths
  // opt out — the bootstrap flow already diagnoses those explicitly.
  if (response.status >= 500 && !isAuthPath(path)) {
    onServiceUnavailable?.();
  }

  throw new ApiError(response.status, await response.text(), response.headers);
}

export const api = {
  get: <T>(path: string) => request<T>(path),

  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    }),

  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    }),

  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    }),

  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "DELETE",
      body: body ? JSON.stringify(body) : undefined,
    }),
};
