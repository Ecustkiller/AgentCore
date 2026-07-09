import { BadgeCheck, CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Inline evidence-status chip for a debater's factual claim (举证责任) — rendered by
 * {@link import("@/components/remarkEvidence").remarkEvidence} in place of a
 * `【已核实·<出处>】` / `【待核实·推断】` marker inside debate speech markdown.
 *
 * - **已核实 (verified)** → success/green tone: the claim carries a real source (shown after ·).
 * - **待核实 (unverified)** → muted/neutral tone (NOT amber — unverified is "not yet grounded",
 *   not "wrong"; honest hedging is a virtue, only passing it off as fact is penalized).
 *
 * Uses a native `title` (not an interactive tooltip trigger) because it renders INSIDE
 * markdown `<p>`/list text — an interactive trigger there risks invalid DOM nesting. Props
 * arrive from the remark node's `data.hProperties` (`data-kind`) + the source/note as children.
 * Mobile-native (own CSS classes + design-token semantic colors); no desktop import.
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
  const label = verified ? "已核实" : "待核实";
  const hint = verified
    ? "辩手标注：这条事实主张有据可查（附出处）"
    : "辩手标注：这条主张暂无出处 / 属推断——拿它当决定性论据会被裁判追问、扣分；诚实存疑本身不扣分";
  const hasNote = children != null && children !== "";
  return (
    <span
      title={hint}
      className={`evidence-badge${verified ? " evidence-verified" : " evidence-unverified"}`}
    >
      <Icon size={11} className="evidence-icon" aria-hidden />
      {label}
      {hasNote ? <span className="evidence-note">·{children}</span> : null}
    </span>
  );
}
