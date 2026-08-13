import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import JSZip from "jszip";
import { logDesktop } from "../../log-service";
import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_FILES,
  BASELINE_KEEP_MAX,
  BASELINE_MAX_AGE_MS,
  LIST_FILES_SKIP_DIRS,
} from "../constants";
import { toReason } from "../pathGuard";
import type { StoredRoot } from "../roots";
import {
  BASELINES_REL,
  INDEX_REL,
  TRASH_REL,
  VERSIONS_REL,
} from "../workspaceIgnore";
import { opErr, opOk } from "./result";

/**
 * Local turn baseline zip — mirror server ``turn_baseline`` / ``zip_dir``.
 *
 * Writes ``{directory}/AgentCore/baselines/{message_id}.zip`` on the user's disk
 * (server has no Path.root for channel LocalWorkspace). Hard-fails on file/byte
 * caps (no truncated "ready"). Probe requires a non-empty zip file.
 *
 * 保留：每次落盘后顺带清理基线区（数量上限 ∧ TTL，与服务端
 * ``prune_local_baselines`` 同策略），失败只打日志。用户命名版本区
 * ``AgentCore/versions`` 永不自动清理，不在清理视野内。
 */

function sanitizeMessageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id) return null;
  if (
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..") ||
    id.includes("\0")
  ) {
    return null;
  }
  return id;
}

function sanitizeDirectory(raw: unknown): string | null {
  const directory =
    typeof raw === "string" ? raw.replace(/^\/+|\/+$/g, "") : "";
  if (
    directory === ".." ||
    directory.startsWith("../") ||
    directory.includes("/../") ||
    directory.endsWith("/..")
  ) {
    return null;
  }
  return directory;
}

function baselineZipAbs(
  rootAbs: string,
  directory: string,
  messageId: string,
): string {
  const base = directory
    ? join(rootAbs, directory, ...BASELINES_REL.split("/"))
    : join(rootAbs, ...BASELINES_REL.split("/"));
  return join(base, `${messageId}.zip`);
}

function shouldSkipDir(name: string): boolean {
  if (LIST_FILES_SKIP_DIRS.has(name)) return true;
  // Path-aware internal zones only under AgentCore/ (handled via rel path).
  return false;
}

function isInternalZoneRel(relRoot: string): boolean {
  const p = relRoot.replace(/\\/g, "/");
  for (const zone of [INDEX_REL, TRASH_REL, BASELINES_REL, VERSIONS_REL]) {
    if (p === zone || p.startsWith(`${zone}/`)) return true;
  }
  return false;
}

async function probeReady(zipAbs: string): Promise<{
  ready: boolean;
  size_bytes: number;
}> {
  try {
    const st = await fs.stat(zipAbs);
    if (st.isFile() && st.size > 0) {
      return { ready: true, size_bytes: st.size };
    }
  } catch {
    // missing / unreadable
  }
  return { ready: false, size_bytes: 0 };
}

async function zipWorkspaceToFile(
  walkRootAbs: string,
  directory: string,
  destAbs: string,
): Promise<{ size_bytes: number } | { reason: string }> {
  const zip = new JSZip();
  let fileCount = 0;
  let totalBytes = 0;
  let limitReason: string | null = null;

  const walk = async (absDir: string, relFromWalk: string): Promise<void> => {
    if (limitReason) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (limitReason) break;
      if (d.isSymbolicLink()) continue;
      const childRelWalk = relFromWalk ? `${relFromWalk}/${d.name}` : d.name;
      const childRelRoot = directory
        ? `${directory}/${childRelWalk}`
        : childRelWalk;
      if (d.isDirectory()) {
        if (shouldSkipDir(d.name)) continue;
        if (isInternalZoneRel(childRelRoot)) continue;
        await walk(join(absDir, d.name), childRelWalk);
      } else if (d.isFile()) {
        if (isInternalZoneRel(childRelRoot)) continue;
        if (fileCount >= ARCHIVE_MAX_FILES) {
          limitReason = "max_files";
          break;
        }
        let buf: Buffer;
        try {
          buf = await fs.readFile(join(absDir, d.name));
        } catch {
          continue;
        }
        if (totalBytes + buf.length > ARCHIVE_MAX_BYTES) {
          limitReason = "max_bytes";
          break;
        }
        zip.file(childRelWalk, buf);
        fileCount++;
        totalBytes += buf.length;
      }
    }
  };

  await walk(walkRootAbs, "");
  if (limitReason) {
    return { reason: limitReason };
  }

  const data = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  await fs.mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, destAbs);
  return { size_bytes: data.length };
}

/**
 * 清理基线区：超出 {@link BASELINE_KEEP_MAX} 或早于 {@link BASELINE_MAX_AGE_MS} 的
 * zip 一律删；刚落盘的 `keepName` 永远保留。按 mtime 排（zip 名是 message id，
 * 不带时间），同 mtime 以文件名兜底定序。只读 `baselines/` 一层目录 —— 同级
 * `versions/` 是用户命名版本，永不自动清理。
 *
 * best-effort：整体失败或单文件删不掉都只打日志，绝不影响已经拿到的基线。
 */
async function pruneBaselines(
  baselinesDirAbs: string,
  keepName: string,
): Promise<void> {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(baselinesDirAbs, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    logDesktop({
      level: "warn",
      event: "workspace.baseline_prune_failed",
      fields: { reason: toReason(e) },
    });
    return;
  }

  const dated: { name: string; mtimeMs: number }[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith(".zip")) continue;
    try {
      const st = await fs.stat(join(baselinesDirAbs, d.name));
      dated.push({ name: d.name, mtimeMs: st.mtimeMs });
    } catch {
      // 读不到时间就当它不在——宁可留着，也不瞎删。
    }
  }
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const cutoff = Date.now() - BASELINE_MAX_AGE_MS;
  let removed = 0;
  for (const [index, entry] of dated.entries()) {
    if (entry.name === keepName) continue;
    if (index < BASELINE_KEEP_MAX && entry.mtimeMs >= cutoff) continue;
    try {
      await fs.unlink(join(baselinesDirAbs, entry.name));
      removed++;
    } catch {
      // 单个删不掉（占用 / 权限）跳过，下次捕获再试。
    }
  }
  if (removed > 0) {
    logDesktop({
      level: "debug",
      event: "workspace.baseline_pruned",
      fields: { removed, keep: BASELINE_KEEP_MAX },
    });
  }
}

/**
 * ``ensure_turn_baseline`` — probe and optionally capture Local zip baseline.
 *
 * args: ``message_id`` (required), ``directory`` (workspace subpath), ``capture``
 * (default true — capture when missing; false = probe only).
 */
export async function opEnsureTurnBaseline(
  root: StoredRoot,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const messageId = sanitizeMessageId(args.message_id);
  if (!messageId) {
    return opErr(
      "WorkspaceIOError",
      "ensure_turn_baseline: invalid message_id",
    );
  }
  const directory = sanitizeDirectory(args.directory);
  if (directory === null) {
    return opErr("OutsideWorkspace", String(args.directory ?? ""));
  }
  const capture = args.capture !== false;
  const zipAbs = baselineZipAbs(root.absPath, directory, messageId);

  try {
    let probe = await probeReady(zipAbs);
    if (probe.ready) {
      return opOk({
        ready: true,
        snapshot_id: messageId,
        size_bytes: probe.size_bytes,
      });
    }
    if (!capture) {
      return opOk({ ready: false, reason: "missing" });
    }

    const walkRootAbs = directory
      ? join(root.absPath, directory)
      : root.absPath;
    try {
      await fs.access(walkRootAbs);
    } catch {
      return opOk({ ready: false, reason: "workspace_missing" });
    }

    const written = await zipWorkspaceToFile(walkRootAbs, directory, zipAbs);
    if ("reason" in written) {
      // Do not leave a partial/false-ready zip.
      try {
        await fs.unlink(zipAbs);
      } catch {
        /* ignore */
      }
      try {
        await fs.unlink(`${zipAbs}.tmp`);
      } catch {
        /* ignore */
      }
      return opOk({ ready: false, reason: written.reason });
    }

    probe = await probeReady(zipAbs);
    if (!probe.ready) {
      return opOk({ ready: false, reason: "empty_or_unreadable" });
    }
    // 捕获是基线区唯一的增长点，清理跟在它后面（对齐云端 create_snapshot 顺带 prune）；
    // 再兜一层 try，是因为清理绝不能把已经拿到的基线倒回成一次失败的 op。
    try {
      await pruneBaselines(dirname(zipAbs), basename(zipAbs));
    } catch {
      /* best-effort */
    }
    return opOk({
      ready: true,
      snapshot_id: messageId,
      size_bytes: probe.size_bytes,
    });
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}
