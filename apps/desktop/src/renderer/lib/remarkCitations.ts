/**
 * Remark plugin: turn inline citation markers `[n]` into `cite:n` link nodes so
 * the Markdown renderer can render them as clickable chips that map to source
 * cards. Only markers within `1..max` are converted (max = the message's source
 * count), so stray brackets and out-of-range numbers stay literal text.
 *
 * Markers inside code / inline-code / existing links are left untouched. No
 * external mdast/unist dependency — a small hand-rolled tree walk keeps the
 * renderer's dependency surface unchanged.
 */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

// Subtrees whose text must stay verbatim (don't rewrite [n] inside code/links).
const SKIP_TYPES = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
]);

const MARKER = /\[(\d+)\]/g;

/** Split a text value into text + `cite:n` link nodes for in-range markers. */
export function splitCitationText(value: string, max: number): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null = MARKER.exec(value);
  MARKER.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex scan
  while ((m = MARKER.exec(value)) !== null) {
    const n = Number(m[1]);
    if (n < 1 || n > max) continue;
    if (m.index > last) {
      parts.push({ type: "text", value: value.slice(last, m.index) });
    }
    parts.push({
      type: "link",
      url: `cite:${n}`,
      children: [{ type: "text", value: String(n) }],
    });
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return [{ type: "text", value }];
  if (last < value.length) {
    parts.push({ type: "text", value: value.slice(last) });
  }
  return parts;
}

function walk(node: MdNode, max: number): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("[")) {
      next.push(...splitCitationText(child.value, max));
    } else {
      if (child.children && !SKIP_TYPES.has(child.type)) walk(child, max);
      next.push(child);
    }
  }
  node.children = next;
}

/** remark attacher factory; pass the source count as `max`. */
export function remarkCitations(max: number) {
  return function attacher() {
    return (tree: MdNode) => {
      if (max > 0) walk(tree, max);
    };
  };
}
