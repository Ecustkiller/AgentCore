import { FactoryGuidePage } from "@/pages/toolbox/FactoryGuidePage";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function CatalogProbe() {
  const [params] = useSearchParams();
  const loc = useLocation();
  return (
    <div
      data-testid="catalog"
      data-path={loc.pathname}
      data-tool={params.get("tool") ?? ""}
      data-skill={params.get("skill") ?? ""}
    />
  );
}

function renderGuides(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/toolbox/guides" element={<FactoryGuidePage />} />
        <Route path="/toolbox/official" element={<CatalogProbe />} />
        <Route path="/toolbox/mine/skills" element={<CatalogProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("FactoryGuidePage", () => {
  it("旧说明书书签收向我的", () => {
    renderGuides(APP_PATHS.toolbox.guides);
    expect(screen.getByTestId("catalog").getAttribute("data-path")).toBe(
      APP_PATHS.toolbox.mine.skills,
    );
  });

  it("保留 ?tool= 收到官方", () => {
    renderGuides(`${APP_PATHS.toolbox.guides}?tool=web_search`);
    expect(screen.getByTestId("catalog").getAttribute("data-path")).toBe(
      APP_PATHS.toolbox.official,
    );
    expect(screen.getByTestId("catalog").getAttribute("data-tool")).toBe(
      "web_search",
    );
  });

  it("保留 ?skill= 收到官方", () => {
    renderGuides(`${APP_PATHS.toolbox.guides}?skill=staffing`);
    expect(screen.getByTestId("catalog").getAttribute("data-path")).toBe(
      APP_PATHS.toolbox.official,
    );
    expect(screen.getByTestId("catalog").getAttribute("data-skill")).toBe(
      "staffing",
    );
  });
});
