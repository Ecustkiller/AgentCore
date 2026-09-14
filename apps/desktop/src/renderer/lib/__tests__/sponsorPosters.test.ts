import { describe, expect, it } from "vitest";
import { resolveSponsorPosters } from "../sponsorPosters";

describe("resolveSponsorPosters", () => {
  it("maps wechat/alipay stems and ignores other files", () => {
    expect(
      resolveSponsorPosters({
        "../assets/support/wechat.png": "/wechat.png",
        "../assets/support/alipay.jpg": "/alipay.jpg",
        "../assets/support/README.md": "/readme",
        "../assets/support/notes.webp": "/notes.webp",
      }),
    ).toEqual({
      wechat: "/wechat.png",
      alipay: "/alipay.jpg",
    });
  });

  it("accepts jpeg/webp for either stem", () => {
    expect(
      resolveSponsorPosters({
        "C:\\\\assets\\\\support\\\\WeChat.WEBP": "/w.webp",
        "./alipay.jpeg": "/a.jpeg",
      }),
    ).toEqual({
      wechat: "/w.webp",
      alipay: "/a.jpeg",
    });
  });

  it("returns empty when the glob matched nothing", () => {
    expect(resolveSponsorPosters({})).toEqual({});
  });
});
