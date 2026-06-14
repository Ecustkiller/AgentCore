import { copyText } from "@/lib/clipboard";
import { Check, Copy } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  isValidElement,
  useState,
} from "react";

/** Recursively concatenate the text of a React subtree.
 *
 * `rehype-highlight` replaces the code body with token <span>s, so the raw
 * source can't be read from a single child — it must be gathered by walking.
 */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** Custom `<pre>` for markdown fenced code: language label + copy button. */
export function CodeBlock({
  children,
  ...props
}: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);

  const className = isValidElement(children)
    ? ((children.props as { className?: string }).className ?? "")
    : "";
  const lang = /language-(\w+)/.exec(className)?.[1] ?? "";
  const text = nodeText(children);

  const onCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{lang || "text"}</span>
        <button
          type="button"
          onClick={onCopy}
          className="code-block-copy"
          aria-label="复制代码"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}
