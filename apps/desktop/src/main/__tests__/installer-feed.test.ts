import { describe, expect, it } from "vitest";
import {
  desktopFeedBase,
  desktopLatestJsonUrl,
  githubInstallerUrl,
  installerFilename,
  parseLatestDesktopJson,
  releaseChannelFromDefine,
  resolveInstallerArtifact,
} from "../installer-feed";

describe("installer-feed", () => {
  it("maps build define to channel and latest.json URL", () => {
    expect(releaseChannelFromDefine(undefined)).toBe("stable");
    expect(releaseChannelFromDefine("stable")).toBe("stable");
    expect(releaseChannelFromDefine("beta")).toBe("beta");
    expect(desktopFeedBase("stable")).toBe(
      "https://downloads.fashitianxia.xyz/desktop/stable",
    );
    expect(desktopLatestJsonUrl("beta")).toBe(
      "https://downloads.fashitianxia.xyz/desktop/beta/latest.json",
    );
  });

  it("names Win exe / Mac dmg; rejects linux", () => {
    expect(installerFilename("0.9.1", "win32")).toBe(
      "AgentCore-0.9.1-win-x64.exe",
    );
    expect(installerFilename("0.9.1", "darwin")).toBe(
      "AgentCore-0.9.1-mac-arm64.dmg",
    );
    expect(installerFilename("0.9.1", "linux")).toBeNull();
    expect(installerFilename("", "win32")).toBeNull();
  });

  it("builds GitHub asset URL matching the website", () => {
    expect(githubInstallerUrl("0.9.1", "AgentCore-0.9.1-win-x64.exe")).toBe(
      "https://github.com/Lawofall/AgentCore-releases/releases/download/v0.9.1/AgentCore-0.9.1-win-x64.exe",
    );
  });

  it("ignores latest.json GitHub URL and uses only a safe filename", () => {
    const latest = parseLatestDesktopJson({
      version: "0.9.1",
      winUrl:
        "https://github.com/evil/repo/releases/download/v0.9.1/wrong-win.exe",
      winFilename: "AgentCore-0.9.1-win-x64.exe",
      macUrl:
        "https://github.com/evil/repo/releases/download/v0.9.1/wrong-mac.dmg",
      macFilename: "prefix/AgentCore-0.9.1-mac-arm64.dmg",
    });
    expect(resolveInstallerArtifact("0.9.1", "win32", latest)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-win-x64.exe"),
      filename: "AgentCore-0.9.1-win-x64.exe",
    });
    expect(resolveInstallerArtifact("0.9.1", "darwin", latest)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-mac-arm64.dmg"),
      filename: "AgentCore-0.9.1-mac-arm64.dmg",
    });
  });

  it("rebuilds GitHub Releases URL when latest.json has a non-GitHub or brand-host URL", () => {
    const latest = parseLatestDesktopJson({
      version: "0.9.1",
      winUrl:
        "https://downloads.fashitianxia.xyz/desktop/stable/AgentCore-0.9.1-win-x64.exe",
      winFilename: "AgentCore-0.9.1-win-x64.exe",
      macUrl: "https://example.invalid/AgentCore-0.9.1-mac-arm64.dmg",
      macFilename: "AgentCore-0.9.1-mac-arm64.dmg",
    });
    expect(resolveInstallerArtifact("0.9.1", "win32", latest)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-win-x64.exe"),
      filename: "AgentCore-0.9.1-win-x64.exe",
    });
    expect(resolveInstallerArtifact("0.9.1", "darwin", latest)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-mac-arm64.dmg"),
      filename: "AgentCore-0.9.1-mac-arm64.dmg",
    });
  });

  it("falls back to the convention filename when latest.json name is unsafe", () => {
    const latest = parseLatestDesktopJson({
      version: "0.9.1",
      winFilename: "..\\evil.exe",
      macFilename: "",
    });
    expect(resolveInstallerArtifact("0.9.1", "win32", latest)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-win-x64.exe"),
      filename: "AgentCore-0.9.1-win-x64.exe",
    });

    const mismatch = parseLatestDesktopJson({
      version: "0.9.1",
      winFilename: "..\\AgentCore-0.9.1-win-x64.exe",
      macFilename: "AgentCore-0.8.0-mac-arm64.dmg",
    });
    expect(resolveInstallerArtifact("0.9.1", "win32", mismatch)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-win-x64.exe"),
      filename: "AgentCore-0.9.1-win-x64.exe",
    });
    expect(resolveInstallerArtifact("0.9.1", "darwin", mismatch)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-mac-arm64.dmg"),
      filename: "AgentCore-0.9.1-mac-arm64.dmg",
    });
  });

  it("ignores latest.json when version mismatches and reconstructs GitHub URL", () => {
    const latest = parseLatestDesktopJson({
      version: "0.8.0",
      winUrl: "https://example.invalid/old.exe",
    });
    expect(resolveInstallerArtifact("0.9.1", "win32", latest)).toEqual({
      url: githubInstallerUrl("0.9.1", "AgentCore-0.9.1-win-x64.exe"),
      filename: "AgentCore-0.9.1-win-x64.exe",
    });
  });

  it("reconstructs when latest.json is missing", () => {
    expect(resolveInstallerArtifact("1.2.3-beta.1", "darwin", null)).toEqual({
      url: githubInstallerUrl(
        "1.2.3-beta.1",
        "AgentCore-1.2.3-beta.1-mac-arm64.dmg",
      ),
      filename: "AgentCore-1.2.3-beta.1-mac-arm64.dmg",
    });
  });
});
