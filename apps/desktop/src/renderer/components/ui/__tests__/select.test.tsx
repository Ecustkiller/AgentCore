// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select } from "../select";

describe("Select", () => {
  it("fills its column by default so a field never renders as a stray narrow box", () => {
    render(
      <Select aria-label="分类" defaultValue="bug">
        <option value="bug">Bug报告</option>
      </Select>,
    );
    expect(screen.getByLabelText("分类").className).toContain("w-full");
  });

  it("keeps the shared field chrome and lets className override it", () => {
    render(
      <Select aria-label="分类" className="w-auto">
        <option value="a">A</option>
      </Select>,
    );
    const el = screen.getByLabelText("分类");
    expect(el.className).toContain("rounded-lg");
    expect(el.className).toContain("border-border");
    expect(el.className).toContain("w-auto");
    expect(el.className).not.toContain("w-full");
  });

  it("stays a native select — options and change events pass through", () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="分类" value="bug" onChange={onChange}>
        <option value="" disabled>
          请选择
        </option>
        <option value="bug">Bug报告</option>
        <option value="feature">功能需求</option>
      </Select>,
    );
    fireEvent.change(screen.getByLabelText("分类"), {
      target: { value: "feature" },
    });
    expect(onChange).toHaveBeenCalled();
    const placeholder = screen.getByRole("option", {
      name: "请选择",
    }) as HTMLOptionElement;
    expect(placeholder.disabled).toBe(true);
  });
});
