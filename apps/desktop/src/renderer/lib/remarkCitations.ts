/**
 * Remark plugin: turn inline citation markers `[n]` into custom `citemark`
 * elements so the Markdown renderer can map them to citation chips.
 *
 * Payload rides on `data.hProperties` (same pattern as {@link ./remarkEvidence}):
 * react-markdown's default `urlTransform` strips non-http(s) link schemes, so the
 * older `cite:n` encoding never reached the chip component. Markers outside
 * `1..max` (max = the message's source count) stay literal text. Markers inside
 * code / inline-code / existing links are left untouched. No external mdast/unist
 * dependency — a small hand-rolled tree walk.
 */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
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

/** One `citemark` element carrying the canonical 1-based pool index. */
function citeNode(n: number): MdNode {
  return {
    type: "cite",
    data: {
      hName: "citemark",
      hProperties: { dataN: String(n) },
    },
    children: [{ type: "text", value: String(n) }],
  };
}

/** Split a text value into text + `citemark` nodes for in-range markers. */
export function splitCitationText(value: string, max: number): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex scan
  while ((m = MARKER.exec(value)) !== null) {
    const n = Number(m[1]);
    if (n < 1 || n > max) continue;
    if (m.index > last) {
      parts.push({ type: "text", value: value.slice(last, m.index) });
    }
    parts.push(citeNode(n));
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
