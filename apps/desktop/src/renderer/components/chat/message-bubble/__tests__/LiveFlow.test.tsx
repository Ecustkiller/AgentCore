// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveFlow, LiveFlowText, LiveWaitLabel } from "../LiveFlow";

afterEach(cleanup);

describe("LiveFlow", () => {
  it("sets data-live-flow only when active", () => {
    const { rerender, container } = render(
      <LiveFlow active={false}>
        <LiveFlowText>x</LiveFlowText>
      </LiveFlow>,
    );
    expect(container.querySelector("[data-live-flow]")).toBeNull();
    rerender(
      <LiveFlow active>
        <LiveFlowText>x</LiveFlowText>
      </LiveFlow>,
    );
    expect(container.querySelector("[data-live-flow]")).not.toBeNull();
    expect(
      container.querySelector("[data-live-flow] .live-flow-text"),
    ).not.toBeNull();
  });
});

describe("LiveWaitLabel", () => {
  it("is always an in-flight surface", () => {
    const { container } = render(<LiveWaitLabel>Thinking…</LiveWaitLabel>);
    expect(container.querySelector("[data-live-flow]")).not.toBeNull();
    expect(container.querySelector(".live-flow-text")).not.toBeNull();
    expect(container.textContent).toContain("Thinking…");
  });
});
