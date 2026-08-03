// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfficialTemplateGuide } from "../OfficialTemplateGuide";

describe("OfficialTemplateGuide", () => {
  it("renders lightweight routing hints without template ids", () => {
    render(<OfficialTemplateGuide />);
    const guide = screen.getByTestId("official-template-guide");
    const text = guide.textContent ?? "";
    expect(text).toMatch(/多角摸底/);
    expect(text).toMatch(/调研报告成文/);
    expect(text).toMatch(/搭建营销站点/);
    expect(text).toMatch(/从零搭应用/);
    expect(text).toMatch(/决策对比/);
    expect(text).not.toMatch(
      /parallel_brief|research_report|build_website|build_app|compare_options/,
    );
  });
});
