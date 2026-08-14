import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "styles.css"),
  "utf8",
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  if (!m) throw new Error(`missing CSS rule ${selector}`);
  return m[1];
}

function colorOf(selector: string): string {
  const m = ruleBody(selector).match(/color:\s*([^;]+);/);
  if (!m) throw new Error(`no color in ${selector}`);
  return m[1].trim();
}

describe("mobile .error surface colors", () => {
  it("generic .error is foreground, not --error", () => {
    expect(colorOf(".error")).toBe("var(--fg)");
    expect(ruleBody(".error")).not.toMatch(/--error/);
  });

  it("keeps first-cut bar / inline-actions split", () => {
    expect(colorOf(".error.bar")).toBe("var(--fg)");
    expect(colorOf(".error.bar.needs-you")).toBe("var(--accent)");
    expect(colorOf(".error.inline-actions")).toBe("var(--fg)");
    expect(colorOf(".error.inline-actions.needs-you")).toBe("var(--accent)");
  });
});
