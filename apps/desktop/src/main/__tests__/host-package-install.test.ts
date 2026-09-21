import { describe, expect, it } from "vitest";
import { shellSilentInstallBlocks } from "../host/shell";

describe("host_shell silent install fuse", () => {
  const samples = [
    "msiexec /i Setup.msi /quiet",
    ".\\Setup.exe /S",
    "Start-Process Setup.exe -ArgumentList '/quiet'",
    "Installer.exe /VERYSILENT",
    "curl -L https://example.com/Setup.exe -o Setup.exe",
  ];

  it.each(samples)("blocks silent installer: %s", (cmd) => {
    const reason = shellSilentInstallBlocks(cmd);
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/启发式兜底|并非完整拦截/);
    expect(reason).toMatch(/winget/);
  });

  it("allows ordinary commands", () => {
    expect(shellSilentInstallBlocks("Get-ChildItem $env:APPDATA")).toBeNull();
    expect(shellSilentInstallBlocks("echo hi")).toBeNull();
  });
});
