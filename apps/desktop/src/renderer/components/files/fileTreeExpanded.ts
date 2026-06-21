const expandedKey = (id: string): string => `agentcore:filetree-expanded:${id}`;

export function loadExpanded(id: string): Set<string> {
  try {
    const raw = localStorage.getItem(expandedKey(id));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

export function saveExpanded(id: string, set: Set<string>): void {
  try {
    localStorage.setItem(expandedKey(id), JSON.stringify([...set]));
  } catch {
    /* unavailable — session-only */
  }
}
