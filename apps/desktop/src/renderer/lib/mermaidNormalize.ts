/**
 * Best-effort repairs for common Mermaid syntax that models emit but parsers reject.
 * Applied before mermaid.parse() — parse failure still falls back to source display.
 */

const ARROW_RE =
  /(-->|---|==>|-\.->|--o|--x|o--o|o--x|x--o|x--x|<-->|<-->|o---o)(?:\|[^|]*\|)?/;

/** Split on `&` outside of quoted strings. */
function splitByAmpersand(segment: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const ch of segment) {
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = true;
      quoteChar = ch;
      current += ch;
    } else if (ch === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = "";
      current += ch;
    } else if (ch === "&" && !inQuote) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

function fixSubgraphLine(line: string, sgCounter: { n: number }): string {
  const match = line.match(/^(\s*subgraph\s+)(.+?)(\s*)$/i);
  if (!match) return line;

  const [, prefix, label, suffix] = match;
  const trimmed = label.trim();

  // Already quoted or bracket-labelled — leave alone.
  if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*[\["']/.test(trimmed)) return line;
  if (/^["']/.test(trimmed)) return line;
  // Bare ASCII id is valid Mermaid.
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return line;

  const id = `sg_${sgCounter.n++}`;
  const escaped = trimmed.replace(/"/g, '\\"');
  return `${prefix}${id}["${escaped}"]${suffix}`;
}

function expandAmpersandEdges(line: string): string | string[] {
  if (!line.includes("&")) return line;

  const arrowMatch = line.match(ARROW_RE);
  if (!arrowMatch || arrowMatch.index === undefined) return line;

  const arrowIdx = arrowMatch.index;
  const arrow = arrowMatch[0];
  const left = line.slice(0, arrowIdx).trim();
  const right = line.slice(arrowIdx + arrow.length).trim();

  const sources = splitByAmpersand(left);
  const targets = splitByAmpersand(right);
  if (sources.length <= 1 && targets.length <= 1) return line;

  const indent = line.match(/^(\s*)/)?.[1] ?? "";
  const edges: string[] = [];
  for (const src of sources) {
    for (const tgt of targets) {
      edges.push(`${indent}${src} ${arrow} ${tgt}`);
    }
  }
  return edges;
}

export function normalizeMermaidSource(code: string): string {
  const sgCounter = { n: 0 };
  const out: string[] = [];

  for (const line of code.split("\n")) {
    if (line.trimStart().startsWith("%%")) {
      out.push(line);
      continue;
    }

    const fixedSubgraph = fixSubgraphLine(line, sgCounter);
    const expanded = expandAmpersandEdges(fixedSubgraph);
    if (Array.isArray(expanded)) {
      out.push(...expanded);
    } else {
      out.push(expanded);
    }
  }

  return out.join("\n");
}
