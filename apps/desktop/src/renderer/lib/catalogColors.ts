import type { ToolCategory } from "@/services/capabilities";
import type { CSSProperties } from "react";

/** Stable toolbox / creation-tool identity keys → `--artifact-*` tokens. */
export type ArtifactKind =
  | "doc"
  | "mindmap"
  | "table"
  | "canvas"
  | "slides"
  | "app"
  | "diagram"
  | "form"
  | "connectors"
  | "workflow"
  | "ai-tools"
  | "manual";

/** CSS `var(...)` for a creation-tool or featured toolbox entry. */
export function artifactColorVar(kind: ArtifactKind): string {
  if (kind === "ai-tools") return "var(--primary)";
  return `var(--artifact-${kind})`;
}

/** CSS `var(...)` for an AI capability catalog tool category. */
export function catalogCategoryColorVar(category: ToolCategory): string {
  return `var(--catalog-${category})`;
}

/** Tinted icon shell (inline only — tokens are not mapped to Tailwind classes). */
export function typeIconShellStyle(
  colorVar: string,
  options?: { muted?: boolean },
): CSSProperties {
  const mix = options?.muted ? "10%" : "14%";
  return {
    backgroundColor: `color-mix(in oklab, ${colorVar} ${mix}, transparent)`,
    color: colorVar,
  };
}
