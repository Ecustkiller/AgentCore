import { errMsg } from "@/lib/errMsg";
import { ApiError } from "@/services/api";
import { describe, expect, it } from "vitest";

describe("errMsg", () => {
  it("prefers the backend's user-facing message", () => {
    const err = new ApiError(
      400,
      JSON.stringify({
        error: { code: "VALIDATION_ERROR", message: "PAT 格式不正确" },
      }),
    );
    expect(errMsg(err, "保存失败，请重试")).toBe("PAT 格式不正确");
  });

  it("falls back when the ApiError carries no server message", () => {
    const err = new ApiError(500, "<html>502 Bad Gateway</html>");
    expect(errMsg(err, "保存失败，请重试")).toBe("保存失败，请重试");
  });

  it("falls back for anything that is not an ApiError", () => {
    expect(errMsg(new Error("boom"), "加载失败")).toBe("加载失败");
    expect(errMsg("boom", "加载失败")).toBe("加载失败");
    expect(errMsg(null, "加载失败")).toBe("加载失败");
  });
});
