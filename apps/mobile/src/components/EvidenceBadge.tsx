import { useEvidenceLedgerMap } from "@/components/EvidenceLedgerContext";
import { extractLedgerId, ledgerBadgeLabel } from "@/lib/evidenceLedger";
import { BadgeCheck, CircleHelp } from "lucide-react";
import { Children, type ReactNode, isValidElement } from "react";

/**
 * Inline evidence-status chip for a debater's factual claim (举证责任 + 证据台账 M1) —
 * rendered by {@link import("@/components/remarkEvidence").remarkEvidence} in place of a
 * `【已核实·<出处|#eN>】` / `【待核实·推断】` marker inside debate speech markdown.
 *
 * - **已核实**：note 含 `#eN` 且台账命中 → 徽章文案换成 site/title（O7：解析必做，溯源面板后置）。
 * - 未命中 / 旧自由文本 → 今日纯文案徽章。
 * - **待核实** → muted 灰（非琥珀）。
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
  const note = nodeText(children).trim();
  const ledger = useEvidenceLedgerMap();
  const ledgerId = verified ? extractLedgerId(note) : null;
  const entry = ledgerId && ledger ? (ledger.get(ledgerId) ?? null) : null;
  const displayNote = entry ? ledgerBadgeLabel(entry) : note;
  const hint = verified
    ? entry
      ? `已核实来源：${displayNote}`
      : "辩手标注：这条事实主张有据可查（附出处）"
    : "辩手标注：这条主张暂无出处 / 属推断——拿它当决定性论据会被裁判追问、扣分；诚实存疑本身不扣分";
  const hasNote = displayNote.length > 0;
  return (
    <span
      title={hint}
      className={`evidence-badge${verified ? " evidence-verified" : " evidence-unverified"}`}
    >
      <Icon size={11} className="evidence-icon" aria-hidden />
      {label}
      {hasNote ? <span className="evidence-note">·{displayNote}</span> : null}
    </span>
  );
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return Children.toArray(node).map(nodeText).join("");
}
