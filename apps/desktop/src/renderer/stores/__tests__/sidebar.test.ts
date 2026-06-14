import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarStore } from "../sidebar";

const store = () => useSidebarStore.getState();

beforeEach(() => {
  useSidebarStore.setState({
    collapsed: false,
    expandedSections: { ungrouped: true },
  });
});

describe("sidebar store", () => {
  describe("toggleCollapsed", () => {
    it("toggles collapsed state", () => {
      expect(store().collapsed).toBe(false);

      store().toggleCollapsed();
      expect(store().collapsed).toBe(true);

      store().toggleCollapsed();
      expect(store().collapsed).toBe(false);
    });
  });

  describe("setCollapsed", () => {
    it("sets collapsed to specific value", () => {
      store().setCollapsed(true);
      expect(store().collapsed).toBe(true);

      store().setCollapsed(false);
      expect(store().collapsed).toBe(false);
    });
  });

  describe("toggleSection", () => {
    it("toggles a section open/closed", () => {
      expect(store().expandedSections.ungrouped).toBe(true);

      store().toggleSection("ungrouped");
      expect(store().expandedSections.ungrouped).toBe(false);

      store().toggleSection("ungrouped");
      expect(store().expandedSections.ungrouped).toBe(true);
    });

    it("defaults undefined sections to toggled on", () => {
      store().toggleSection("new-folder");
      expect(store().expandedSections["new-folder"]).toBe(true);
    });
  });
});
