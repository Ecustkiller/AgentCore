import { useEvidenceLedgerMap } from "@/components/chat/EvidenceLedgerContext";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { statusPillSoft } from "@/components/ui/tone-presets";
import {
  extractLedgerId,
  ledgerBadgeLabel,
  ledgerDateLabel,
  ledgerTierLabel,
} from "@/lib/evidenceLedger";
import type { EvidenceLedgerEntry } from "@/types/events";
import { BadgeCheck, CircleHelp, ExternalLink } from "lucide-react";
import { Children, type ReactNode, isValidElement } from "react";

/**
 * Inline evidence-status chip for a debater's factual claim (举证责任 P3 + 证据台账 M1) —
 * rendered by {@link import("@/lib/remarkEvidence").remarkEvidence} in place of a
 * `【已核实·<出处|#eN>】` / `【待核实·推断】` marker inside debate speech markdown.
 *
 * - **已核实 (verified)** → success tone. Note 含 `#eN` 且台账命中 → 徽章文案换成
 *   site/title，点击开溯源 Popover；未命中 / 旧自由文本 → 今日纯文案徽章（不可点）。
 * - **待核实 (unverified)** → muted tone（非琥珀）。
 *
 * 台账 map 由 {@link EvidenceLedgerProvider} 注入（辩论室树）；无 Provider 时一律降级纯文案。
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
  const note = nodeText(children).trim();
  const ledger = useEvidenceLedgerMap();
  const ledgerId = verified ? extractLedgerId(note) : null;
  const entry = ledgerId && ledger ? (ledger.get(ledgerId) ?? null) : null;

  if (entry) {
    const display = ledgerBadgeLabel(entry);
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`mx-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded px-1 align-middle text-[0.92em] font-medium ${tone}`}
            aria-label={`已核实 · ${display}（查看来源）`}
          >
            <Icon size={11} className="shrink-0" aria-hidden />
            {label}
            <span className="opacity-80">·{display}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start" side="top">
          <EvidenceLedgerCard entry={entry} />
        </PopoverContent>
      </Popover>
    );
  }

  const hint = verified
    ? "辩手标注：这条事实主张有据可查（附出处）"
    : "辩手标注：这条主张暂无出处 / 属推断——拿它当决定性论据会被裁判追问、扣分；诚实存疑本身不扣分";
  const hasNote = note.length > 0;
  return (
    <span
      title={hint}
      className={`mx-0.5 inline-flex items-center gap-0.5 rounded px-1 align-middle text-[0.92em] font-medium ${tone}`}
    >
      <Icon size={11} className="shrink-0" aria-hidden />
      {label}
      {hasNote ? <span className="opacity-80">·{note}</span> : null}
    </span>
  );
}

function EvidenceLedgerCard({ entry }: { entry: EvidenceLedgerEntry }) {
  const title = (entry.title ?? "").trim();
  const site = (entry.site ?? "").trim();
  const url = (entry.url ?? "").trim();
  const snippet = (entry.snippet ?? "").trim();
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium tabular-nums text-foreground">
          {entry.id}
        </span>
        <span className="shrink-0">{ledgerTierLabel(entry.tier)}</span>
      </div>
      <div className="font-medium text-foreground">
        {title || site || entry.id}
      </div>
      {site && title ? (
        <div className="text-xs text-muted-foreground">{site}</div>
      ) : null}
      <div className="text-xs text-muted-foreground">
        {ledgerDateLabel(entry.date)}
      </div>
      {snippet ? (
        <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {snippet}
        </p>
      ) : null}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          打开来源
          <ExternalLink size={11} aria-hidden />
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">底料条目（无外链）</p>
      )}
    </div>
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
