/** 画布放大态 per-turn 视图偏好（群聊 / 对比 / 协作图 …），按对话×回合记忆。 */

export type CanvasTurnView = "room" | "graph" | "compare" | "timeline";

const STORAGE_KEY = "agentcore:canvas-turn-views";

const VALID: ReadonlySet<CanvasTurnView> = new Set([
  "room",
  "graph",
  "compare",
  "timeline",
]);

/** 迁移：旧「版本对比」独立视图 `revisions` 已并入统一「对比」透镜 `compare`（对比擂台 ∪ 版本链）。
 * 读旧持久值时归一，避免用户下次进画布丢掉曾选的对比视图。 */
function migrate(v: string): string {
  return v === "revisions" ? "compare" : v;
}

function entryKey(conversationId: string, turnId: string): string {
  return `${conversationId}:${turnId}`;
}

function loadAll(): Record<string, CanvasTurnView> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, CanvasTurnView> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && VALID.has(migrate(v) as CanvasTurnView)) {
        out[k] = migrate(v) as CanvasTurnView;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveAll(views: Record<string, CanvasTurnView>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    /* unavailable — session-only */
  }
}

export function loadCanvasTurnView(
  conversationId: string,
  turnId: string,
): CanvasTurnView | null {
  return loadAll()[entryKey(conversationId, turnId)] ?? null;
}

export function persistCanvasTurnView(
  conversationId: string,
  turnId: string,
  view: CanvasTurnView,
): void {
  const all = loadAll();
  all[entryKey(conversationId, turnId)] = view;
  saveAll(all);
}

/** Pick a saved view when still valid for this turn's tab strip, else the natural default. */
export function resolveCanvasTurnView(
  saved: CanvasTurnView | null,
  naturalDefault: CanvasTurnView,
  available: ReadonlySet<CanvasTurnView>,
): CanvasTurnView {
  if (saved && available.has(saved)) return saved;
  return naturalDefault;
}
