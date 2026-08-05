import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceOpenRel,
  resolveWorkspaceProtocolRequest,
} from "../workspace-browser-url";

describe("resolveWorkspaceProtocolRequest", () => {
  it("同 cid 可解析", () => {
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv-a/site/index.html",
        "conv-a",
      ),
    ).toEqual({
      ok: true,
      conversationId: "conv-a",
      rel: "site/index.html",
    });
  });

  it("跨 cid / 缺 path → 403；非法 scheme → 400", () => {
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv-b/site/index.html",
        "conv-a",
      ),
    ).toEqual({ ok: false, status: 403 });
    expect(
      resolveWorkspaceProtocolRequest("workspace://conv-a/", "conv-a"),
    ).toEqual({ ok: false, status: 403 });
    expect(
      resolveWorkspaceProtocolRequest("https://example.com/x", "conv-a"),
    ).toEqual({ ok: false, status: 400 });
  });

  it("路径守卫 fail-closed（盘符 / null 字节）", () => {
    // URL 构造器会折叠 `../` 与段级 `%2e%2e`；纵深仍拒盘符与 null。
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv-a/C:/windows",
        "conv-a",
      ),
    ).toEqual({ ok: false, status: 403 });
    expect(
      resolveWorkspaceProtocolRequest("workspace://conv-a/%00x.html", "conv-a"),
    ).toEqual({ ok: false, status: 403 });
  });
});

describe("resolveWorkspaceOpenRel", () => {
  it("本会话返回 rel；跨会话 / 空 cid / 非 workspace → null", () => {
    expect(
      resolveWorkspaceOpenRel("workspace://Conv-1/dir/a%20b.html", "conv-1"),
    ).toBe("dir/a b.html");
    expect(
      resolveWorkspaceOpenRel("workspace://other/site/index.html", "conv-1"),
    ).toBeNull();
    expect(
      resolveWorkspaceOpenRel("workspace://conv-1/site/index.html", null),
    ).toBeNull();
    expect(resolveWorkspaceOpenRel("https://example.com", "conv-1")).toBeNull();
    expect(resolveWorkspaceOpenRel("file:///tmp/x.html", "conv-1")).toBeNull();
  });
});
