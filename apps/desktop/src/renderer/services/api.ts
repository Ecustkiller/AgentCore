const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
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
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });

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

  throw new ApiError(response.status, await response.text());
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

  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
