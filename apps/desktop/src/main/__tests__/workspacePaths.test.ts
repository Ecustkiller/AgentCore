import { describe, expect, it } from "vitest";
import {
  buildWorkspaceUrl,
  mimeForPath,
  normalizePreviewPath,
  resolveWorkspaceHtmlUrl,
  workspaceFilePath,
} from "../browser/workspace-paths";

describe("normalizePreviewPath（协议路径守卫）", () => {
  it("放行嵌套相对路径", () => {
    expect(normalizePreviewPath("/dir/index.html")).toBe("dir/index.html");
    expect(normalizePreviewPath("/img/logo.png")).toBe("img/logo.png");
  });

  it("剥离前导斜杠与 . 段", () => {
    expect(normalizePreviewPath("/./a/./b.css")).toBe("a/b.css");
  });

  it("拒绝 .. 穿越（原始与百分号编码）", () => {
    expect(normalizePreviewPath("/../secret")).toBeNull();
    expect(normalizePreviewPath("/a/../../secret")).toBeNull();
    expect(normalizePreviewPath("/%2e%2e/secret")).toBeNull();
    expect(normalizePreviewPath("/a/%2e%2e/%2e%2e/secret")).toBeNull();
  });

  it("拒绝空路径 / null 字节 / Windows 盘符", () => {
    expect(normalizePreviewPath("/")).toBeNull();
    expect(normalizePreviewPath("")).toBeNull();
    expect(normalizePreviewPath("/a\u0000b")).toBeNull();
    expect(normalizePreviewPath("/C:/windows/system32")).toBeNull();
  });

  it("解码百分号编码的段", () => {
    expect(normalizePreviewPath("/a%20b/c.html")).toBe("a b/c.html");
  });

  it("strip 沙箱绝对根 /workspace/…（与写盘语义对齐，避免 workspace/… 假子目录）", () => {
    expect(normalizePreviewPath("/workspace/index.html")).toBe("index.html");
    expect(normalizePreviewPath("/workspace/site/index.html")).toBe(
      "site/index.html",
    );
    expect(normalizePreviewPath("/workspace")).toBeNull();
    // 相对形故意不 strip：可能是真子目录 workspace/
    expect(normalizePreviewPath("workspace/index.html")).toBe(
      "workspace/index.html",
    );
    expect(normalizePreviewPath("/other/index.html")).toBe("other/index.html");
  });
});

describe("workspaceFilePath（desk /v1/workspaces 寻址）", () => {
  it("拼出 workspaces files 端点、wsId 整体 encode、path 逐段编码", () => {
    expect(workspaceFilePath("conv:c1", "dir/a b.html")).toBe(
      "/v1/workspaces/conv%3Ac1/files/dir/a%20b.html",
    );
    expect(workspaceFilePath("folder:fid-1", "site/index.html")).toBe(
      "/v1/workspaces/folder%3Afid-1/files/site/index.html",
    );
  });
});

describe("resolveWorkspaceHtmlUrl / buildWorkspaceUrl（openWorkspaceHtml）", () => {
  it("带 workspaceId 构造 desk host URL", () => {
    expect(
      resolveWorkspaceHtmlUrl("cid-1", "site/index.html", "folder:fid-9"),
    ).toBe("workspace://folder.fid-9/site/index.html");
    expect(buildWorkspaceUrl("folder:fid-9", "site/index.html")).toBe(
      "workspace://folder.fid-9/site/index.html",
    );
  });

  it("缺省 workspaceId 回退 conv:{conversationId}", () => {
    expect(resolveWorkspaceHtmlUrl("Conv-ID", "dir/a b.html")).toBe(
      "workspace://conv.conv-id/dir/a%20b.html",
    );
  });

  it("非法 path / desk → null", () => {
    expect(resolveWorkspaceHtmlUrl("c1", "../x")).toBeNull();
    expect(resolveWorkspaceHtmlUrl("c1", "a.html", "project:x")).toBeNull();
    expect(resolveWorkspaceHtmlUrl("", "a.html")).toBeNull();
  });
});

describe("mimeForPath（按扩展名推断 MIME）", () => {
  it("映射常见 web 类型（大小写不敏感）", () => {
    expect(mimeForPath("index.html")).toMatch(/^text\/html/);
    expect(mimeForPath("style.css")).toMatch(/^text\/css/);
    expect(mimeForPath("app.js")).toMatch(/text\/javascript/);
    expect(mimeForPath("data.json")).toMatch(/application\/json/);
    expect(mimeForPath("logo.svg")).toBe("image/svg+xml");
    expect(mimeForPath("pic.PNG")).toBe("image/png");
    expect(mimeForPath("font.woff2")).toBe("font/woff2");
  });

  it("未知 / 无扩展名 / 点在目录段 → octet-stream", () => {
    expect(mimeForPath("file.xyz")).toBe("application/octet-stream");
    expect(mimeForPath("noext")).toBe("application/octet-stream");
    expect(mimeForPath("dir.with.dot/file")).toBe("application/octet-stream");
  });
});
