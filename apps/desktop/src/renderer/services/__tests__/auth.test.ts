import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapAuth } from "../auth";

const ME = "/v1/auth/me";
const READYZ = "/readyz";

const backendUser = {
  id: "u1",
  username: "dev",
  display_name: "Dev",
  email: null,
  role: "admin",
  created_at: "2024-01-01T00:00:00Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = (url: string) => Response;

function mockFetch(handler: Handler): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))),
  );
}

beforeEach(() => {
  // Force dev auto-login to a no-op so bootstrap exercises only the cookie and
  // health-probe branches deterministically, regardless of any local .env.local.
  vi.stubEnv("VITE_DEV_USERNAME", "");
  vi.stubEnv("VITE_DEV_PASSWORD", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bootstrapAuth", () => {
  it("returns authenticated when the session cookie is valid", async () => {
    mockFetch((url) => {
      if (url.endsWith(ME)) return json(backendUser);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await bootstrapAuth();

    expect(result.kind).toBe("authenticated");
    if (result.kind === "authenticated") {
      expect(result.user.username).toBe("dev");
    }
  });

  it("returns unauthenticated on 401 when the backend is ready", async () => {
    mockFetch((url) => {
      if (url.endsWith(ME)) return json({ error: "no session" }, 401);
      if (url.endsWith(READYZ)) return json({ status: "ready", database: true });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await bootstrapAuth();

    expect(result.kind).toBe("unauthenticated");
  });

  it("returns unavailable on 401 when /readyz reports the database down", async () => {
    mockFetch((url) => {
      if (url.endsWith(ME)) return json({ error: "no session" }, 401);
      if (url.endsWith(READYZ))
        return json({ status: "not_ready", database: false }, 503);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await bootstrapAuth();

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toContain("数据库");
    }
  });

  it("returns unavailable when /auth/me 500s (server reachable but broken)", async () => {
    mockFetch((url) => {
      if (url.endsWith(ME)) return json({ error: "boom" }, 500);
      if (url.endsWith(READYZ))
        return json({ status: "not_ready", database: false }, 503);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await bootstrapAuth();

    expect(result.kind).toBe("unavailable");
  });

  it("returns unavailable when the backend is unreachable (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const result = await bootstrapAuth();

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toContain("无法连接后端");
    }
  });
});
