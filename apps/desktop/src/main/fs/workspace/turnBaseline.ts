import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import JSZip from "jszip";
import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_FILES,
  LIST_FILES_SKIP_DIRS,
} from "../constants";
import { toReason } from "../pathGuard";
import type { StoredRoot } from "../roots";
import { BASELINES_REL, INDEX_REL, TRASH_REL } from "../workspaceIgnore";
import { opErr, opOk } from "./result";

/**
 * Local turn baseline zip — mirror server ``turn_baseline`` / ``zip_dir``.
 *
 * Writes ``{directory}/AgentCore/baselines/{message_id}.zip`` on the user's disk
 * (server has no Path.root for channel LocalWorkspace). Hard-fails on file/byte
 * caps (no truncated "ready"). Probe requires a non-empty zip file.
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
  for (const zone of [INDEX_REL, TRASH_REL, BASELINES_REL]) {
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
    return opOk({
      ready: true,
      snapshot_id: messageId,
      size_bytes: probe.size_bytes,
    });
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}
