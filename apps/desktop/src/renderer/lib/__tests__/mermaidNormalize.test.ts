import { normalizeMermaidSource } from "@/lib/mermaidNormalize";
import { describe, expect, it } from "vitest";

describe("normalizeMermaidSource", () => {
  it("fixes bare Chinese subgraph labels", () => {
    const input = "flowchart TD\nsubgraph 应用层\nA --> B\nend";
    const out = normalizeMermaidSource(input);
    expect(out).toContain('subgraph sg_0["应用层"]');
    expect(out).not.toContain("subgraph 应用层");
  });

  it("leaves already-bracketed subgraph labels unchanged", () => {
    const input = 'flowchart TD\nsubgraph app["应用层"]\nA --> B\nend';
    expect(normalizeMermaidSource(input)).toBe(input);
  });

  it("expands ampersand target edges", () => {
    const input = "flowchart TD\nL --> H & I & J & K";
    const out = normalizeMermaidSource(input);
    expect(out).toContain("L --> H");
    expect(out).toContain("L --> I");
    expect(out).toContain("L --> J");
    expect(out).toContain("L --> K");
    expect(out).not.toContain("&");
  });

  it("expands mixed ampersand source and target edges", () => {
    const input = "flowchart TD\nJ & K --> F & G";
    const out = normalizeMermaidSource(input);
    expect(out).toContain("J --> F");
    expect(out).toContain("J --> G");
    expect(out).toContain("K --> F");
    expect(out).toContain("K --> G");
    expect(out).not.toContain("&");
  });

  it("expands labeled ampersand target edges", () => {
    const input = "flowchart TD\nA -->|yes| B & C";
    const out = normalizeMermaidSource(input);
    expect(out).toContain("A -->|yes| B");
    expect(out).toContain("A -->|yes| C");
    expect(out).not.toContain("&");
  });

  it("does not modify comment lines", () => {
    const input = "%% A --> B & C\nflowchart TD";
    const out = normalizeMermaidSource(input);
    expect(out).toContain("%% A --> B & C");
  });
});
