/**
 * mac codesign 能力探测：Authority 解析 + 缓存 + 失败降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, probe, h } = vi.hoisted(() => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const probe = {
    mode: "ok" as "ok" | "reject" | "timeout",
    stderr:
      "Authority=Developer ID Application: Example Inc (ABCD1234)\nAuthority=Developer ID Certification Authority\n",
    calls: 0,
  };
  const execFileMock = Object.assign(vi.fn(), {
    // promisify(execFile) 走 custom；在此计数并返回结果。
    [custom]: async () => {
      probe.calls += 1;
      execFileMock();
      if (probe.mode === "reject") {
        throw new Error("code object is not signed");
      }
      if (probe.mode === "timeout") {
        throw Object.assign(new Error("Timed out"), {
          killed: true,
          code: null,
        });
      }
      return { stdout: "", stderr: probe.stderr };
    },
  });
  return {
    execFileMock,
    probe,
    h: { isPackaged: true },
  };
});

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    getPath: (name: string) => {
      if (name === "exe") {
        return "/Applications/AgentCore.app/Contents/MacOS/AgentCore";
      }
      return "/tmp";
    },
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

import {
  __resetMacAutoUpdateCapableCacheForTests,
  hasTrustedMacCodesignAuthority,
  isMacAutoUpdateInstallCapable,
  macAppBundlePath,
} from "../mac-auto-update-capable";

describe("hasTrustedMacCodesignAuthority", () => {
  it("accepts Developer ID Application leaf", () => {
    const out = [
      "Executable=/Applications/AgentCore.app/Contents/MacOS/AgentCore",
      "Identifier=com.agentcore.desktop",
      "Format=app bundle with Mach-O thin (arm64)",
      "Authority=Developer ID Application: Example Inc (ABCD1234)",
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
    ].join("\n");
    expect(hasTrustedMacCodesignAuthority(out)).toBe(true);
  });

  it("accepts Apple Distribution leaf", () => {
    const out =
      "Authority=Apple Distribution: Example Inc (ABCD1234)\nAuthority=Apple Worldwide Developer Relations Certification Authority\n";
    expect(hasTrustedMacCodesignAuthority(out)).toBe(true);
  });

  it("rejects ad-hoc / unsigned / intermediate-only", () => {
    expect(hasTrustedMacCodesignAuthority("Signature=adhoc\n")).toBe(false);
    expect(hasTrustedMacCodesignAuthority("")).toBe(false);
    expect(
      hasTrustedMacCodesignAuthority(
        "Authority=Developer ID Certification Authority\nAuthority=Apple Root CA\n",
      ),
    ).toBe(false);
  });
});

describe("macAppBundlePath", () => {
  it("walks up from Contents/MacOS binary to .app", () => {
    const exe = "/Applications/AgentCore.app/Contents/MacOS/AgentCore";
    // path.resolve 在 win 宿主上会规范化盘符前缀；只断言相对 .app 根。
    expect(macAppBundlePath(exe).replace(/\\/g, "/")).toMatch(
      /\/Applications\/AgentCore\.app$/,
    );
  });
});

describe("isMacAutoUpdateInstallCapable", () => {
  const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    __resetMacAutoUpdateCapableCacheForTests();
    h.isPackaged = true;
    probe.mode = "ok";
    probe.calls = 0;
    probe.stderr =
      "Authority=Developer ID Application: Example Inc (ABCD1234)\nAuthority=Developer ID Certification Authority\n";
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    execFileMock.mockClear();
  });

  afterEach(() => {
    __resetMacAutoUpdateCapableCacheForTests();
    if (prevPlatform) {
      Object.defineProperty(process, "platform", prevPlatform);
    }
  });

  it("returns true without probing on non-darwin", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    await expect(isMacAutoUpdateInstallCapable()).resolves.toBe(true);
    expect(probe.calls).toBe(0);
  });

  it("returns true without probing when unpackaged", async () => {
    h.isPackaged = false;
    await expect(isMacAutoUpdateInstallCapable()).resolves.toBe(true);
    expect(probe.calls).toBe(0);
  });

  it("returns true when Developer ID Application present", async () => {
    await expect(isMacAutoUpdateInstallCapable()).resolves.toBe(true);
    expect(probe.calls).toBe(1);
  });

  it("returns false on codesign failure / unsigned", async () => {
    probe.mode = "reject";
    await expect(isMacAutoUpdateInstallCapable()).resolves.toBe(false);
  });

  it("returns false on timeout", async () => {
    probe.mode = "timeout";
    await expect(isMacAutoUpdateInstallCapable()).resolves.toBe(false);
  });

  it("caches the first probe result", async () => {
    await expect(isMacAutoUpdateInstallCapable()).resolves.toBe(true);
    await expect(isMacAutoUpdateInstallCapable()).resolves.toBe(true);
    expect(probe.calls).toBe(1);
  });
});
