/**
 * 深链解析的安全边界（最后修订 2026-11-04）。
 *
 * 深链是外部输入，解析必须 fail closed：任何不认识的 URL 都只让主进程聚焦
 * 窗口、不产生跳转。这些用例是防止「顺手支持一下任意路径」时把入口放宽。
 */
import { describe, expect, it } from "vitest";
import { deepLinkFromArgv, parseDeepLink } from "../deep-link";

describe("parseDeepLink · 合法形状", () => {
  it("接受显式 path 参数（URL 编码）", () => {
    expect(parseDeepLink("nexus://open?path=%2Fconversations%2Fabc-123")).toBe(
      "/conversations/abc-123",
    );
  });

  it("接受未编码的 path 参数与 query", () => {
    expect(parseDeepLink("nexus://open?path=/more/general")).toBe(
      "/more/general",
    );
    expect(parseDeepLink("nexus://open?path=/messages/7?tab=2")).toBe(
      "/messages/7?tab=2",
    );
  });

  it("接受 host 为空的路径式深链", () => {
    expect(parseDeepLink("nexus:///conversations/abc-123")).toBe(
      "/conversations/abc-123",
    );
  });

  it("根路由归一化为 /", () => {
    expect(parseDeepLink("nexus://open?path=/")).toBe("/");
  });

  it("scheme 大小写不敏感（WHATWG URL 会规范化，OS 亦如此分发）", () => {
    expect(parseDeepLink("NEXUS://open?path=/files")).toBe("/files");
  });
});

describe("parseDeepLink · 一律拒绝", () => {
  const bad = [
    "",
    "not a url",
    "https://example.com/conversations/1",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "nexus://open", // 没有 path
    "nexus://open?path=conversations/1", // 不以 / 开头
    "nexus://open?path=//evil.example", // 协议相对 URL
    "nexus://open?path=/files%2F..%5C..%5Cetc", // 反斜杠
    "nexus://open?path=/files#injected", // fragment
    "nexus://open?path=/files%20name", // 空格
    "nexus://open?path=/admin/users", // 不在允许区段
    "nexus://user:pass@open?path=/files", // 凭据
    "nexus://open?path=/files%0Adocument.cookie", // 控制字符
    "nexus://open?path=/files<script>", // 尖括号
  ];

  for (const raw of bad) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(parseDeepLink(raw)).toBeNull();
    });
  }

  it("超长 URL 直接拒绝", () => {
    expect(
      parseDeepLink(`nexus://open?path=/files/${"a".repeat(3000)}`),
    ).toBeNull();
  });
});

describe("deepLinkFromArgv", () => {
  it("从 Windows 第二个实例的命令行里挑出深链", () => {
    expect(
      deepLinkFromArgv([
        "/path/to/Nexus.exe",
        "--allow-file-access",
        "nexus://open?path=/conversations/42",
      ]),
    ).toBe("nexus://open?path=/conversations/42");
  });

  it("没有深链时返回 null", () => {
    expect(deepLinkFromArgv(["/path/to/Nexus.exe", "--foo"])).toBeNull();
  });

  it("冷启动 argv（首个实例，非 second-instance）也能解析出站内路由", () => {
    const raw = deepLinkFromArgv([
      "/Applications/Nexus.app/Contents/MacOS/Nexus",
      "nexus://open?path=/conversations/cold-start",
    ]);
    expect(raw).not.toBeNull();
    // 主进程把这一段交给 parseDeepLink 后才存 pending；两段必须接得上。
    expect(parseDeepLink(raw ?? "")).toBe("/conversations/cold-start");
  });
});
