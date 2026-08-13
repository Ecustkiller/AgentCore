/**
 * What one entry actually holds, line by line.
 *
 * 「这条不对」lands on a whole entry, but what the user saw was a single sentence in the
 * 「记忆已更新」card. To name the lines that go quiet alongside the wrong one, this mirrors
 * the shape the server writes memory files in (`memory/user_memory.py`): optional
 * frontmatter, human chrome (an H1 title + the blockquote note under it), then
 * `## 小节` headers over `- bullet <!-- ts:YYYY-MM-DD -->` lines.
 *
 * Free-form entries (a hand-written rule that is one paragraph, not a bullet list) yield
 * no lines — the caller must say「整份内容」rather than invent a count.
 */

/** One bullet inside an entry, with the `## 小节` it sits under. */
export interface EntryMemoryLine {
  /** Enclosing section; null for bullets written above the first `## 小节`. */
  section: string | null;
  /** Bullet text with the invisible timestamp marker removed. */
  text: string;
}

const FENCE = "---";
const SECTION_RE = /^##\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const TS_RE = /<!--\s*ts:[^>]*-->/g;
/** A top-level title (`# …`), distinct from `##` sections. */
const H1_RE = /^#\s+\S/;

/**
 * Drop a well-formed frontmatter block. An unclosed opening fence is left as-is —
 * same rule as the server's `strip_entry_frontmatter`: never guess-repair.
 */
function stripFrontmatter(lines: string[]): string[] {
  if (lines.length === 0 || lines[0].trim() !== FENCE) return lines;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) return lines.slice(i + 1);
  }
  return lines;
}

/** Drop the leading H1 and the blockquote note under it — chrome written for the reader. */
function stripChrome(lines: string[]): string[] {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length || !H1_RE.test(lines[i])) return lines;
  i++;
  while (
    i < lines.length &&
    (!lines[i].trim() || lines[i].trimStart().startsWith(">"))
  ) {
    i++;
  }
  return lines.slice(i);
}

/** Every bullet an entry holds, in file order. Empty for a free-form / empty entry. */
export function parseEntryMemoryLines(markdown: string): EntryMemoryLine[] {
  const lines = stripChrome(stripFrontmatter(markdown.split(/\r?\n/)));
  const out: EntryMemoryLine[] = [];
  let section: string | null = null;
  for (const raw of lines) {
    const header = SECTION_RE.exec(raw);
    if (header) {
      section = header[1].trim() || null;
      continue;
    }
    const bullet = BULLET_RE.exec(raw);
    if (!bullet) continue;
    const text = bullet[1].replace(TS_RE, "").trim();
    if (text) out.push({ section, text });
  }
  return out;
}
