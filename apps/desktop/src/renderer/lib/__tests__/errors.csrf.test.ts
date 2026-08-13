import { errMsg } from "@/lib/errMsg";
import {
  CSRF_FAILED_MESSAGE,
  describeError,
  streamErrorFromResponse,
} from "@/lib/errors";
import { ApiError } from "@/services/api";
import { describe, expect, it } from "vitest";

/**
 * 后端把 CSRF 拒绝写成一句英文开发者文案（middleware/csrf.py），而 REST / SSE /
 * 表单三条链路各自成句。这里钉的是「同一次拒绝，三处一模一样，且给得出下一步」。
 */
const CSRF_BODY = JSON.stringify({
  error: {
    code: "CSRF_FAILED",
    message: "CSRF token missing or invalid. Re-login and retry.",
  },
});

describe("CSRF_FAILED 用户面", () => {
  it("replaces the backend's English sentence with actionable zh copy", () => {
    const described = describeError(new ApiError(403, CSRF_BODY));

    expect(described?.message).toBe(CSRF_FAILED_MESSAGE);
    expect(described?.message).not.toMatch(/CSRF token/i);
    // 服务端在这条 403 上就补发了可用令牌（api 层已收下），原样重试即可——
    // 别再让用户退出重登，也就不需要通往账户页的出口。
    expect(described?.message).not.toMatch(/重新登录|退出|刷新/);
    expect(described?.action).toBeNull();
    expect(described?.retriable).toBe(true);
  });

  it("phrases the inline form message identically", () => {
    expect(errMsg(new ApiError(403, CSRF_BODY), "上传失败，请重试")).toBe(
      CSRF_FAILED_MESSAGE,
    );
  });

  it("phrases a refused SSE POST identically", async () => {
    const err = await streamErrorFromResponse(
      new Response(CSRF_BODY, {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(err.code).toBe("CSRF_FAILED");
    expect(describeError(err)?.message).toBe(CSRF_FAILED_MESSAGE);
  });

  it("keeps status-only phrasing when the refusal body is not JSON", async () => {
    const err = await streamErrorFromResponse(
      new Response("<html>gateway</html>", { status: 502 }),
    );

    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(describeError(err)?.message).toContain("502");
  });
});
