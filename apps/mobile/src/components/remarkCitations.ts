// Remark plugin: turn inline citation markers `[n]` into `cite:n` link nodes so the
// Markdown renderer can render them as clickable chips mapped to the source list. Only
// markers within 1..max convert (max = the message's source count); stray brackets and
// out-of-range numbers stay literal. Markers inside code / links are left untouched.
//
// Mirror of the desktop lib/remarkCitations.ts — a dependency-free pure leaf (cross-
// platform-frontend.mdc allows mirroring such leaves; mobile keeps its own to stay
// decoupled). No mdast/unist dependency: a small hand-rolled tree walk.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

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
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null = MARKER.exec(value);
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
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
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
