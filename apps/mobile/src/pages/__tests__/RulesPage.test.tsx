// @vitest-environment jsdom
/**
 * 旧 /rules 深链 replace 到 /memory，避免书签 404。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { RulesPage } from "@/pages/RulesPage";

afterEach(cleanup);

describe("RulesPage", () => {
  it("replace 到 /memory", () => {
    render(
      <MemoryRouter initialEntries={["/rules"]}>
        <Routes>
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/memory" element={<div>memory-target</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("memory-target")).toBeTruthy();
  });
});
