import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "../ui";

const store = () => useUIStore.getState();

beforeEach(() => {
  useUIStore.setState({
    searchOpen: false,
    searchInitialQuery: "",
  });
});

describe("useUIStore openSearch", () => {
  it("openSearch() with no args keeps searchInitialQuery as empty string (sidebar SearchTrigger)", () => {
    // Sidebar SearchTrigger calls openSearch() bare — must not write undefined
    // (CommandPalette then does query.trim() and would crash).
    store().openSearch();

    expect(store().searchOpen).toBe(true);
    expect(store().searchInitialQuery).toBe("");
    expect(typeof store().searchInitialQuery).toBe("string");
  });

  it("openSearch(q) prefills the query", () => {
    store().openSearch("foo");
    expect(store().searchOpen).toBe(true);
    expect(store().searchInitialQuery).toBe("foo");
  });
});
