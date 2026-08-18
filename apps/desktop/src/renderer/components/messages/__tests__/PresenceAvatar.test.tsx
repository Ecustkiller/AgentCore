// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PresenceAvatar } from "../PresenceAvatar";

afterEach(cleanup);

describe("PresenceAvatar", () => {
  it("shows the letter and skips an image request when url is null", () => {
    const { container } = render(
      <PresenceAvatar
        label="A"
        url={null}
        sizeClass="size-8"
        textClass="text-xs"
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy();
  });

  it("resolves a relative avatar_url against BASE_URL", () => {
    const { container } = render(
      <PresenceAvatar
        label="A"
        url="/v1/users/u1/avatar?v=abc"
        sizeClass="size-8"
        textClass="text-xs"
      />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "http://localhost:8000/v1/users/u1/avatar?v=abc",
    );
    expect(screen.queryByText("A")).toBeNull();
  });

  it("falls back to the letter after an image error", () => {
    const { container } = render(
      <PresenceAvatar
        label="B"
        url="/v1/users/u1/avatar?v=bad"
        sizeClass="size-8"
        textClass="text-xs"
      />,
    );
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("B")).toBeTruthy();
  });

  it("keeps the online green dot", () => {
    render(
      <PresenceAvatar
        label="C"
        sizeClass="size-8"
        textClass="text-xs"
        online
      />,
    );
    expect(screen.getByLabelText("在线")).toBeTruthy();
  });
});
