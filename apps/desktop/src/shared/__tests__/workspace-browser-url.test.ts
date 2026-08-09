import { describe, expect, it } from "vitest";

import {
  hostToWorkspaceId,
  resolveWorkspaceOpenRel,
  resolveWorkspaceProtocolRequest,
  workspaceIdToHost,
} from "../workspace-browser-url";

describe("workspaceId ↔ host 编解码", () => {
  it("folder/conv 双向往返", () => {
    expect(workspaceIdToHost("folder:abc-123")).toBe("folder.abc-123");
    expect(workspaceIdToHost("conv:550e8400-e29b-41d4-a716-446655440000")).toBe(
      "conv.550e8400-e29b-41d4-a716-446655440000",
    );
    expect(hostToWorkspaceId("folder.abc-123")).toBe("folder:abc-123");
    expect(hostToWorkspaceId("conv.550e8400-e29b-41d4-a716-446655440000")).toBe(
      "conv:550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("大小写归一；非法 kind / 缺 id → null", () => {
    expect(workspaceIdToHost("Folder:XYZ")).toBe("folder.xyz");
    expect(hostToWorkspaceId("CONV.Abc")).toBe("conv:abc");
    expect(workspaceIdToHost("project:x")).toBeNull();
    expect(workspaceIdToHost("folder:")).toBeNull();
    expect(workspaceIdToHost("nocolon")).toBeNull();
    expect(hostToWorkspaceId("folder")).toBeNull();
    expect(hostToWorkspaceId("other.x")).toBeNull();
  });
});

describe("resolveWorkspaceProtocolRequest", () => {
  it("同 conv desk 可解析", () => {
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv.conv-a/site/index.html",
        "conv-a",
      ),
    ).toEqual({
      ok: true,
      workspaceId: "conv:conv-a",
      rel: "site/index.html",
    });
  });

  it("folder desk 本 partition 放行（鉴权靠服务端）", () => {
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://folder.fid-1/site/index.html",
        "conv-a",
      ),
    ).toEqual({
      ok: true,
      workspaceId: "folder:fid-1",
      rel: "site/index.html",
    });
  });

  it("跨 conv / 旧裸 cid host / 缺 path → 403；非法 scheme → 400", () => {
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv.conv-b/site/index.html",
        "conv-a",
      ),
    ).toEqual({ ok: false, status: 403 });
    // 旧形 workspace://{cid}/… 不再合法（无 folder.|conv. 前缀）
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv-a/site/index.html",
        "conv-a",
      ),
    ).toEqual({ ok: false, status: 403 });
    expect(
      resolveWorkspaceProtocolRequest("workspace://conv.conv-a/", "conv-a"),
    ).toEqual({ ok: false, status: 403 });
    expect(
      resolveWorkspaceProtocolRequest("https://example.com/x", "conv-a"),
    ).toEqual({ ok: false, status: 400 });
  });

  it("路径守卫 fail-closed（盘符 / null 字节）", () => {
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv.conv-a/C:/windows",
        "conv-a",
      ),
    ).toEqual({ ok: false, status: 403 });
    expect(
      resolveWorkspaceProtocolRequest(
        "workspace://conv.conv-a/%00x.html",
        "conv-a",
      ),
    ).toEqual({ ok: false, status: 403 });
  });
});

describe("resolveWorkspaceOpenRel", () => {
  it("本会话 / folder desk 返回 rel；跨会话 / 空 cid / 非 workspace → null", () => {
    expect(
      resolveWorkspaceOpenRel(
        "workspace://conv.Conv-1/dir/a%20b.html",
        "conv-1",
      ),
    ).toBe("dir/a b.html");
    expect(
      resolveWorkspaceOpenRel(
        "workspace://folder.f1/site/index.html",
        "conv-1",
      ),
    ).toBe("site/index.html");
    expect(
      resolveWorkspaceOpenRel(
        "workspace://conv.other/site/index.html",
        "conv-1",
      ),
    ).toBeNull();
    expect(
      resolveWorkspaceOpenRel("workspace://conv.conv-1/site/index.html", null),
    ).toBeNull();
    expect(resolveWorkspaceOpenRel("https://example.com", "conv-1")).toBeNull();
    expect(resolveWorkspaceOpenRel("file:///tmp/x.html", "conv-1")).toBeNull();
  });
});
