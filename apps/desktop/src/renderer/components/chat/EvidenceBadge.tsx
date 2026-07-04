import { statusPillSoft } from "@/components/ui/tone-presets";
import { BadgeCheck, CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Inline evidence-status chip for a debater's factual claim (举证责任 P3, 方案 A) —
 * rendered by {@link import("@/lib/remarkEvidence").remarkEvidence} in place of a
 * `【已核实·<出处>】` / `【待核实·推断】` marker inside debate speech markdown.
 *
 * - **已核实 (verified)** → success tone: the claim carries a real source (shown after ·).
 * - **待核实 (unverified)** → muted/neutral tone (NOT amber — the warning slot is retired
 *   design-wide; unverified is "not yet grounded", not "wrong"). Honest hedging is a virtue;
 *   only passing an unverified claim off as fact is what the judge penalizes.
 *
 * Uses a native `title` (not a Tooltip trigger) because it renders INSIDE markdown
 * `<p>`/list text — an interactive trigger there risks invalid DOM nesting. Props arrive
 * from the remark node's `data.hProperties` (`data-kind`) + the source/note as children.
 */
export function EvidenceBadge({
  "data-kind": kind,
  children,
}: {
  "data-kind"?: string;
  children?: ReactNode;
}) {
  const verified = kind === "verified";
  const Icon = verified ? BadgeCheck : CircleHelp;
  const tone = verified ? statusPillSoft.success : statusPillSoft.muted;
  const label = verified ? "已核实" : "待核实";
  const hint = verified
    ? "辩手标注：这条事实主张有据可查（附出处）"
    : "辩手标注：这条主张暂无出处 / 属推断——拿它当决定性论据会被裁判追问、扣分；诚实存疑本身不扣分";
  const hasNote = children != null && children !== "";
  return (
    <span
      title={hint}
      className={`mx-0.5 inline-flex items-center gap-0.5 rounded px-1 align-middle text-[0.92em] font-medium ${tone}`}
    >
      <Icon size={11} className="shrink-0" aria-hidden />
      {label}
      {hasNote ? <span className="opacity-80">·{children}</span> : null}
    </span>
  );
}
