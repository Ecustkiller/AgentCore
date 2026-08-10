import {
  clientChannelLabelZh,
  clientReleaseChannel,
  desktopDownloadUrlForChannel,
  otherChannelDownloadLabel,
  otherChannelDownloadUrl,
  otherReleaseChannel,
} from "@/lib/releaseChannel";
import { describe, expect, it } from "vitest";

describe("releaseChannel", () => {
  it("defaults to stable when build define is absent", () => {
    expect(clientReleaseChannel()).toBe("stable");
    expect(clientChannelLabelZh()).toBe("稳定");
  });

  it("maps the other track and download URLs", () => {
    expect(otherReleaseChannel("stable")).toBe("beta");
    expect(otherReleaseChannel("beta")).toBe("stable");
    expect(desktopDownloadUrlForChannel("beta")).toBe(
      "https://fashitianxia.xyz/download?channel=beta",
    );
    expect(desktopDownloadUrlForChannel("stable")).toBe(
      "https://fashitianxia.xyz/download?channel=stable",
    );
    expect(otherChannelDownloadUrl("stable")).toBe(
      "https://fashitianxia.xyz/download?channel=beta",
    );
    expect(otherChannelDownloadLabel("stable")).toBe("下载测试版");
    expect(otherChannelDownloadLabel("beta")).toBe("下载稳定版");
  });
});
