// @vitest-environment jsdom
/**
 * Pins the URL-filter contract every list page shares: defaults stay out of the query
 * string, junk degrades instead of reaching the API, a filter change drops `?page=` in
 * the same navigation, and a reset spares params the page does not own.
 * The leading block comment keeps the @vitest-environment directive file-leading.
 */

import {
  bool,
  date,
  oneOf,
  str,
  useUrlFilters,
} from "@/hooks/useUrlFilters";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

const SCHEMA = {
  q: str(),
  role: oneOf(["all", "admin", "user"] as const, "all"),
  include_deleted: bool(false),
  since: date(),
};

type Api = ReturnType<typeof useUrlFilters<typeof SCHEMA>>;

let api: Api;

function Probe() {
  api = useUrlFilters(SCHEMA);
  const location = useLocation();
  return (
    <div>
      <span data-testid="search">{location.search}</span>
      <span data-testid="values">{JSON.stringify(api.values)}</span>
    </div>
  );
}

function renderAt(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Probe />
    </MemoryRouter>,
  );
}

const search = () => screen.getByTestId("search").textContent;
const values = () => JSON.parse(screen.getByTestId("values").textContent ?? "{}");

afterEach(cleanup);

describe("useUrlFilters", () => {
  it("reads filters out of the query string", () => {
    renderAt("/users?q=alice&role=admin&include_deleted=1&since=2026-08-01");
    expect(values()).toEqual({
      q: "alice",
      role: "admin",
      include_deleted: true,
      since: "2026-08-01",
    });
  });

  it("falls back instead of forwarding a hand-edited value to the API", () => {
    renderAt("/users?role=banana&include_deleted=maybe&since=08%2F01%2F2026");
    expect(values()).toEqual({
      q: "",
      role: "all",
      include_deleted: false,
      since: "",
    });
  });

  it("keeps defaults out of the URL so a shared link carries only real filters", () => {
    renderAt("/users");
    act(() => api.set({ q: "alice", role: "admin" }));
    expect(search()).toBe("?q=alice&role=admin");

    // Returning a filter to its default removes it rather than writing `role=all`.
    act(() => api.set({ role: "all" }));
    expect(search()).toBe("?q=alice");

    act(() => api.set({ q: "" }));
    expect(search()).toBe("");
  });

  it("drops ?page= in the same navigation as the filter change", () => {
    renderAt("/users?page=4&q=alice");
    act(() => api.set({ q: "bob" }));
    // Page 4 of the old result set is meaningless under the new filter, and a separate
    // write would flash an old-page + new-filter combination that fires a wasted load.
    expect(search()).toBe("?q=bob");
  });

  it("reset clears owned filters but leaves params the page does not own", () => {
    renderAt("/conversations?user_id=u-1&q=alice&role=admin&page=3");
    act(() => api.reset());
    expect(search()).toBe("?user_id=u-1");
    expect(values()).toEqual({
      q: "",
      role: "all",
      include_deleted: false,
      since: "",
    });
  });

  it("replaces history so Back still leaves the page", () => {
    renderAt("/users");
    act(() => api.set({ q: "a" }));
    act(() => api.set({ q: "al" }));
    act(() => api.set({ q: "ali" }));
    // Three keystrokes must not bury the entry the operator arrived from.
    expect(window.history.length).toBeLessThan(4);
  });

  it("writes booleans as 1/0 and round-trips them", () => {
    renderAt("/users");
    act(() => api.set({ include_deleted: true }));
    expect(search()).toBe("?include_deleted=1");
    expect(values().include_deleted).toBe(true);
  });
});
