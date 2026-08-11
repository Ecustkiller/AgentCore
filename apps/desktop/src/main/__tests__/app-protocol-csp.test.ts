import { describe, expect, it } from "vitest";
import {
  apiOriginForCsp,
  connectSrcForCsp,
  decodeAppRelativePath,
  frameSrcForCsp,
} from "../app-protocol-csp";

describe("decodeAppRelativePath（app:// pathname）", () => {
  it("根路径落到 index.html", () => {
    expect(decodeAppRelativePath("/")).toBe("index.html");
  });

  it("解码合法百分号编码", () => {
    expect(decodeAppRelativePath("/assets/a%20b.js")).toBe("assets/a b.js");
  });

  it("畸形百分号编码返回 null（不抛 URIError）", () => {
    expect(decodeAppRelativePath("/%E0%A4%A")).toBeNull();
    expect(decodeAppRelativePath("/%ZZ")).toBeNull();
    expect(decodeAppRelativePath("/%")).toBeNull();
  });
});

describe("connectSrcForCsp（失败收紧）", () => {
  it("有 API origin 时钉死自己 + http(s) + 同源 ws", () => {
    expect(connectSrcForCsp("https://api.example.com")).toBe(
      "connect-src 'self' https://api.example.com wss://api.example.com",
    );
    expect(connectSrcForCsp("http://localhost:8000")).toBe(
      "connect-src 'self' http://localhost:8000 ws://localhost:8000",
    );
  });

  it("源为空时收紧到 'self'，不放开 https:/http:/ws:/wss:", () => {
    const directive = connectSrcForCsp("");
    expect(directive).toBe("connect-src 'self'");
    expect(directive).not.toMatch(/\bhttps:/);
    expect(directive).not.toMatch(/\bhttp:/);
    expect(directive).not.toMatch(/\bws:/);
    expect(directive).not.toMatch(/\bwss:/);
  });
});

describe("frameSrcForCsp（PDF iframe，勿过度放宽）", () => {
  it("放行 self + blob: + data:，不含 https: / *", () => {
    const directive = frameSrcForCsp();
    expect(directive).toBe("frame-src 'self' blob: data:");
    expect(directive).toMatch(/\bblob:/);
    expect(directive).toMatch(/\bdata:/);
    expect(directive).not.toMatch(/\bhttps:/);
    expect(directive).not.toMatch(/\*/);
  });
});

describe("apiOriginForCsp", () => {
  it("合法 URL 取 origin", () => {
    expect(apiOriginForCsp("https://api.example.com/v1")).toBe(
      "https://api.example.com",
    );
  });

  it("畸形 / 空串返回空（供 CSP 收紧）", () => {
    expect(apiOriginForCsp("")).toBe("");
    expect(apiOriginForCsp("not-a-url")).toBe("");
  });
});
