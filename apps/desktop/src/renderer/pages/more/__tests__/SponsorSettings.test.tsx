// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SponsorSettings } from "../SponsorSettings";

afterEach(cleanup);

describe("SponsorSettings", () => {
  it("shows the empty note when this build has no posters", () => {
    render(<SponsorSettings posters={{}} />);
    expect(screen.getByRole("heading", { name: "赞助" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("这一版没有附上收款码。")).toBeTruthy();
  });

  it("renders wechat and alipay posters when urls are present", () => {
    render(
      <SponsorSettings
        posters={{ wechat: "/wechat.png", alipay: "/alipay.jpg" }}
      />,
    );
    expect(
      screen.getByRole("img", { name: "微信收款码" }).getAttribute("src"),
    ).toContain("wechat.png");
    expect(
      screen.getByRole("img", { name: "支付宝收款码" }).getAttribute("src"),
    ).toContain("alipay.jpg");
    expect(screen.queryByText("这一版没有附上收款码。")).toBeNull();
  });
});
