import { copyText } from "@/lib/messageExport";
import {
  type SupportDiagnosticIds,
  formatSupportDiagnosticText,
} from "@/lib/supportDiagnostics";
import { useState } from "react";

/** Inline「复制排查包」(empty failure bubbles have no footer copy row). */
export function SupportDiagnosticCopyButton({
  ids,
}: {
  ids: SupportDiagnosticIds;
}) {
  const [copied, setCopied] = useState(false);
  const text = formatSupportDiagnosticText(ids);
  if (!text) return null;
  return (
    <button
      type="button"
      className="msg-copy-btn"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "已复制" : "复制排查包"}
    </button>
  );
}
