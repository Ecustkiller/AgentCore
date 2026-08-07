/**
 * Login/register must send X-Client-Platform — server fail-closes on /v1/auth/token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/push", () => ({
  enablePush: vi.fn(),
  disablePush: vi.fn(),
}));

vi.mock("@/lib/clientBuildInfo", () => ({
  clientHeaders: () => ({
    "X-Client-Platform": "android",
    "X-Client-Version": "test",
  }),
}));

import { login, register } from "../auth";

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonOk({
        access_token: "a",
        refresh_token: "r",
        user: { id: "u1", username: "jhr123" },
      }),
    ),
  );
});

describe("auth · X-Client-Platform", () => {
  it("login POST /v1/auth/token includes platform header", async () => {
    await login("jhr123", "secret");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/auth/token"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Client-Platform": "android",
          "X-Client-Version": "test",
        }),
      }),
    );
  });

  it("register includes platform header", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonOk({ id: "u1", username: "jhr123" }),
    );
    await register({ username: "jhr123", password: "secret" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/auth/register"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Client-Platform": "android",
        }),
      }),
    );
  });
});
