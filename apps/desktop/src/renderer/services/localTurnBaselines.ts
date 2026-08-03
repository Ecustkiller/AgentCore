/**
 * Local 回合基线发现 —— 读本机 `AgentCore/baselines/{messageId}.zip` 目录。
 * 不经云 snapshot REST；与 sidecar restoreTurnBaseline 同源路径约定。
 */

const BASELINES_DIR = "AgentCore/baselines";

function baselinesRel(subpath: string): string {
  const base = subpath.replace(/^\/+|\/+$/g, "");
  return base ? `${base}/${BASELINES_DIR}` : BASELINES_DIR;
}

/** 列出本机工作区已落盘的回合基线 id（= zip stem = assistant message id）。 */
export async function listLocalTurnBaselineIds(
  rootId: string,
  subpath = "",
): Promise<string[]> {
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.listDir) return [];
  const res = await fsApi.listDir(rootId, baselinesRel(subpath));
  if (!res.ok) return [];
  const ids: string[] = [];
  for (const e of res.data) {
    if (e.kind !== "file") continue;
    if (!e.name.endsWith(".zip")) continue;
    const id = e.name.slice(0, -".zip".length);
    if (id) ids.push(id);
  }
  return ids;
}
