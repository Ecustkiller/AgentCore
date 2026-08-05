// @vitest-environment jsdom
import { CollapsibleUserText } from "@/components/CollapsibleUserText";
import { InterjectionBubbles } from "@/components/InterjectionBubbles";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

describe("CollapsibleUserText", () => {
  it("短文（无溢出）不显示展开按钮", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(40);
    const clientSpy = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(40);

    render(<CollapsibleUserText contentKey="hi">短消息</CollapsibleUserText>);

    expect(screen.queryByRole("button", { name: "展开全文" })).toBeNull();
    expect(screen.getByText("短消息")).toBeTruthy();

    spy.mockRestore();
    clientSpy.mockRestore();
  });

  it("溢出时默认夹住，可展开再收起", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(400);
    const clientSpy = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(100);

    render(
      <CollapsibleUserText contentKey="long">
        {"长文\n".repeat(40)}
      </CollapsibleUserText>,
    );

    const expand = screen.getByRole("button", { name: "展开全文" });
    expect(expand).toBeTruthy();
    expect(
      document.querySelector(".collapsible-user-text-body.is-clamped"),
    ).toBeTruthy();
    expect(document.querySelector(".collapsible-user-text-fade")).toBeTruthy();

    fireEvent.click(expand);
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();
    expect(
      document.querySelector(".collapsible-user-text-body.is-clamped"),
    ).toBeNull();
    expect(document.querySelector(".collapsible-user-text-fade")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getByRole("button", { name: "展开全文" })).toBeTruthy();
    expect(
      document.querySelector(".collapsible-user-text-body.is-clamped"),
    ).toBeTruthy();

    spy.mockRestore();
    clientSpy.mockRestore();
  });
});

describe("InterjectionBubbles · 用户气泡折叠", () => {
  it("长插话正文走 CollapsibleUserText", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(400);
    const clientSpy = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(100);

    render(
      <InterjectionBubbles
        items={[
          {
            interjectionId: "ij-1",
            content: "插话长文\n".repeat(30),
            status: "acked",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "展开全文" })).toBeTruthy();
    expect(
      document.querySelector(
        "[data-testid='interjection-bubble-ij-1'] .collapsible-user-text",
      ),
    ).toBeTruthy();

    spy.mockRestore();
    clientSpy.mockRestore();
  });
});
