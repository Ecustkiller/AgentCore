// @vitest-environment jsdom

import { loadFileSort } from "@/components/files/fileWorkbench/storage";
import { uiSet } from "@/lib/uiStorage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("loadFileSort", () => {
  it("mtime 原样返回，未知与旧 size 回落 name", () => {
    expect(loadFileSort()).toBe("name");

    uiSet("files-sort-by", "mtime");
    expect(loadFileSort()).toBe("mtime");

    uiSet("files-sort-by", "size");
    expect(loadFileSort()).toBe("name");

    uiSet("files-sort-by", "bogus");
    expect(loadFileSort()).toBe("name");
  });
});
